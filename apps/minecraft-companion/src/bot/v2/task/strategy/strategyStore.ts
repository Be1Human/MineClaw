/**
 * L6 · StrategyStore —— 固化策略库（FEAT-CROSS-07 R2/R6/R7）
 *
 * 持久化：每个 strategy 一个 JSON 文件 data/strategies/<id>.json；1s TTL 热加载（抄 tuning 范式，
 *   主人手改/删 JSON 下次读即生效）。upsert 写盘即更新内存。
 * 置信度：recordRun 多维加权打分（gate/耗时/受伤/降级）滑动窗口 + 生命周期状态机
 *   （candidate→trusted 累计无降级成功≥N；安全违规一票否决拉黑；trusted 置信度跌破阈值退回候选）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tuning } from '../../infra/tuning.js';
import type { Strategy, RunOutcome, StrategyState, OwnerVerdict } from './strategyTypes.js';

const TTL_MS = 1000;
/** BUG-CROSS-20 · 候选连续试用仍无一次无降级成功时，停止继续污染 fast path。 */
const CANDIDATE_ZERO_SUCCESS_LIMIT = 3;

function isZeroSuccessCandidateExhausted(strategy: Strategy): boolean {
  const lifecycle = strategy.lifecycle;
  return lifecycle.state === 'candidate'
    && lifecycle.trialRuns >= CANDIDATE_ZERO_SUCCESS_LIMIT
    && lifecycle.cleanSuccess === 0;
}

export class StrategyStore {
  private cache = new Map<string, Strategy>();
  private lastScan = 0;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (m: string) => void = () => {},
  ) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    this.scan(true);
  }

  // ── 读 ───────────────────────────────────────────────
  list(): Strategy[] {
    this.scanIfStale();
    return [...this.cache.values()];
  }
  get(id: string): Strategy | undefined {
    this.scanIfStale();
    return this.cache.get(id);
  }
  /** 可用候选（启用 + 未拉黑/禁用 + 置信度达标） */
  usable(): Strategy[] {
    const min = tuning().strategy.minConfidenceToUse;
    return this.list().filter(s =>
      (s.lifecycle.state === 'candidate' || s.lifecycle.state === 'trusted') &&
      s.lifecycle.ownerVerdict !== 'rejected' &&
      !isZeroSuccessCandidateExhausted(s) &&
      s.lifecycle.confidence >= min);
  }

  // ── 写 ───────────────────────────────────────────────
  upsert(s: Strategy): void {
    // 静态查环（FEAT-CROSS-07 R8）：沉淀/晋升不得成环；剔掉会成环的 deps
    const safeDeps = (s.lifecycle.deps ?? []).filter(dep => !this.reachesBack(dep, s.id));
    if (safeDeps.length !== (s.lifecycle.deps ?? []).length) {
      this.log(`[strategy] ${s.id} 检出循环依赖 → 剔除成环 deps`);
      s.lifecycle.deps = safeDeps;
    }
    s.lifecycle.updatedAt = this.now();
    this.cache.set(s.id, s);
    this.persist(s);
  }

  /** dep 经其 deps 链是否能回到 target（成环检测） */
  private reachesBack(dep: string, target: string, seen = new Set<string>()): boolean {
    if (dep === target) return true;
    if (seen.has(dep)) return false;
    seen.add(dep);
    const d = this.cache.get(dep);
    if (!d) return false;
    return (d.lifecycle.deps ?? []).some(x => this.reachesBack(x, target, seen));
  }

  remove(id: string): void {
    this.cache.delete(id);
    try { rmSync(join(this.dir, `${id}.json`), { force: true }); } catch { /* ignore */ }
  }

  /** 主人主权：否决 > 自动评分（rejected→禁用永不命中；approved→标记可信留痕） */
  ownerVerdict(id: string, verdict: OwnerVerdict): void {
    const s = this.get(id);
    if (!s) return;
    s.lifecycle.ownerVerdict = verdict;
    if (verdict === 'rejected') s.lifecycle.state = 'disabled';
    if (verdict === 'approved' && s.lifecycle.state === 'candidate') s.lifecycle.state = 'trusted';
    this.upsert(s);
  }

  setState(id: string, state: StrategyState): void {
    const s = this.get(id);
    if (!s) return;
    s.lifecycle.state = state;
    this.upsert(s);
  }

  /** 执行回灌：多维打分 → 滑动窗口置信度 + 生命周期晋升/降级/拉黑 */
  recordRun(id: string, outcome: RunOutcome): void {
    const s = this.get(id);
    if (!s) return;
    const lc = s.lifecycle;
    lc.trialRuns += 1;

    // 安全违规 → 一票否决永久拉黑（红线，不进加权）
    if (outcome.safetyViolation) {
      lc.state = 'blacklisted';
      lc.confidence = 0;
      this.upsert(s);
      this.log(`[strategy] ${id} 安全违规 → 拉黑`);
      return;
    }

    const w = tuning().strategy.weights;
    const gate = outcome.ok ? 1 : 0;
    const dg = outcome.downgraded ? 0 : 1;
    const hurt = 1 - Math.min(1, (outcome.hurt ?? 0) / 20);
    const time = outcome.ok ? 1 : 0; // 无 slow 基线 → 用 gate 代理（后续可接真基线）
    const runScore = w.gate * gate + w.time * time + w.hurt * hurt + w.downgrade * dg;

    const win = tuning().strategy.windowSize;
    lc.recentRuns = [...(lc.recentRuns ?? []), runScore].slice(-win);
    lc.confidence = lc.recentRuns.reduce((a, b) => a + b, 0) / lc.recentRuns.length;

    if (outcome.ok && !outcome.downgraded) lc.cleanSuccess += 1;

    // 晋升 / 降级
    if (lc.state === 'candidate' && lc.cleanSuccess >= tuning().strategy.promoteN) {
      lc.state = 'trusted';
      this.log(`[strategy] ${id} 晋升 trusted（cleanSuccess=${lc.cleanSuccess}）`);
    } else if (isZeroSuccessCandidateExhausted(s)) {
      lc.state = 'disabled';
      this.log(`[strategy] ${id} 候选试用 ${lc.trialRuns} 次仍无 clean success → disabled`);
    } else if (lc.state === 'trusted' && lc.confidence < tuning().strategy.demoteConfidence) {
      lc.state = 'candidate';
      this.log(`[strategy] ${id} 置信度跌破 → 退回 candidate`);
    }
    this.upsert(s);
  }

  // ── 内部持久化 / 热加载 ───────────────────────────────
  private persist(s: Strategy): void {
    try { writeFileSync(join(this.dir, `${s.id}.json`), JSON.stringify(s, null, 2), 'utf8'); }
    catch (e) { this.log(`[strategy] 写盘失败 ${s.id}: ${e instanceof Error ? e.message : e}`); }
  }

  private scanIfStale(): void {
    if (this.now() - this.lastScan >= TTL_MS) this.scan(false);
  }

  private scan(initial: boolean): void {
    this.lastScan = this.now();
    if (!existsSync(this.dir)) return;
    let files: string[];
    try { files = readdirSync(this.dir).filter(f => f.endsWith('.json')); }
    catch { return; }
    const seen = new Set<string>();
    for (const f of files) {
      const id = f.replace(/\.json$/, '');
      seen.add(id);
      try {
        const raw = readFileSync(join(this.dir, f), 'utf8');
        const s = JSON.parse(raw) as Strategy;
        if (s && s.id && s.bt) this.cache.set(s.id, s);
      } catch (e) {
        if (initial) this.log(`[strategy] 跳过坏 JSON ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }
    // 文件被外部删 → 内存同步剔除
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    void statSync; // 保留引用（未来按 mtime 增量加载）
  }
}
