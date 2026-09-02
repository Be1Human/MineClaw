/**
 * 评测体系 · 被测 bot（FEAT-CROSS-02 · 阶段〇）
 *
 * 定位：把线上同款 V2Runtime 装配起来作为"被试"，但
 *   - LLM 关闭（llm: undefined）→ 走规则模式，行为确定可复现
 *   - 任务经 taskRuntime 直注 / move_to 请求直 submit → 不依赖大模型决策
 *
 * 关键：本文件【只用 V2Runtime / MineflayerConnection 的现有公开接口】，
 * 不改任何线上代码（阶段〇铁律：零线上改动）。
 */

import { MineflayerConnection } from '../../../apps/minecraft-companion/src/bot/mineflayer/index.js';
import { V2Runtime } from '../../../apps/minecraft-companion/src/bot/v2/index.js';
import type { ConnectionConfig } from '../../../apps/minecraft-companion/src/bot/mineflayer/types.js';
import type { ActionRequest } from '../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Loc } from './director.js';

export interface SubjectConfig {
  host: string;
  port: number;
  username: string;
  auth?: ConnectionConfig['auth'];
  version?: string;
  /** owner 名（跟随场景指向导演 username；非跟随场景导演会被 parkFar） */
  ownerName: string;
  /** 局部坐标原点（与导演同一 anchor），供场景 success 判定换算世界坐标 */
  anchor: Loc;
  onLog?: (msg: string) => void;
  /** 把 v2 bus 事件透传给 runner（用于 watchdog 计数） */
  onEvent?: (type: string) => void;
}

export class Subject {
  private conn: MineflayerConnection;
  private v2: V2Runtime | null = null;
  private reqSeq = 0;
  /** BUG-CROSS-06 · 当前 repeat 的移动评测任务，给所有 movement 请求提供执行权背书。 */
  private moveTaskId: string | null = null;
  private log: (msg: string) => void;
  /** 最近一次 move_to 原子结束的结果（NAV-05 "干净放弃"判定用） */
  private lastMove: { ok: boolean; at: number } | null = null;
  /** BUG-CROSS-29：锁存当前 repeat 的死亡事件；服务器自动重生后 health 会恢复。 */
  private diedInRun = false;
  private unsubscribeDeath: (() => void) | null = null;
  readonly username: string;
  readonly anchor: Loc;

  constructor(private readonly cfg: SubjectConfig) {
    this.conn = new MineflayerConnection();
    this.log = cfg.onLog ?? (() => {});
    this.username = cfg.username;
    this.anchor = cfg.anchor;
  }

  /** 局部坐标 → 世界坐标 */
  world(lx: number, ly: number, lz: number): Loc {
    return { x: this.anchor.x + lx, y: this.anchor.y + ly, z: this.anchor.z + lz };
  }

  /** 竞技场地板站立面的世界 y（= anchor.y） */
  anchorY(): number { return this.anchor.y; }

  get runtime(): V2Runtime {
    if (!this.v2) throw new Error('Subject runtime not started');
    return this.v2;
  }

  async connect(): Promise<void> {
    const connCfg: ConnectionConfig = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      version: this.cfg.version,
      auth: this.cfg.auth ?? 'offline',
      reconnect: { enabled: false, maxRetries: 0, baseDelay: 1000, maxDelay: 1000 },
    };
    await this.conn.connect(connCfg);
    this.v2 = new V2Runtime({
      game: this.conn.gameAdapter,
      nav: this.conn.navAdapter,
      ownerName: this.cfg.ownerName,
      tickMs: 200,
      blockingExecute: false,
      // BUG-CROSS-30：评测复位的 task.cancelled 仅用于观测，不得触发 MainBrain 重建旧目标。
      taskFeedbackEnabled: false,
      llm: undefined,                 // ← LLM 关闭，确定性
      botName: this.cfg.username,
      dbPath: `data/eval-memory.db`,  // 评测专用库，不污染线上
      worldMapDbPath: `data/eval-world-map.db`,
      getRawBotForPatch: () => {
        try { return this.conn.getBot() as unknown as import('../../../apps/minecraft-companion/src/bot/v2/infra/patchedBlockAt.js').BotBlockAtTarget; }
        catch { return null; }
      },
      onLog: (_lvl, msg) => this.log(msg),
      onEvent: (ev) => this.cfg.onEvent?.(ev.type),
    });
    this.v2.start();
    this.unsubscribeDeath = this.conn.gameAdapter.onDeath(() => {
      this.diedInRun = true;
    });
    // 追踪 move_to 结束结果（NAV-05 干净放弃判定）
    this.v2.bus.on('atomic.move_to.end', (ev) => {
      const ok = (ev.payload as { ok?: boolean })?.ok === true;
      this.lastMove = { ok, at: Date.now() };
    });
    this.log(`[subject] V2Runtime started · owner=${this.cfg.ownerName} · LLM=off`);
  }

  async disconnect(): Promise<void> {
    try { this.unsubscribeDeath?.(); } catch { /* ignore */ }
    this.unsubscribeDeath = null;
    try { this.v2?.stop(); } catch { /* ignore */ }
    this.v2 = null;
    try { await this.conn.disconnect(); } catch { /* ignore */ }
  }

  // ─────────────── 注入 ───────────────

  /**
   * 注入一个 move_to 请求（NAV/REC 场景用）。
   * 走 heart.submitRequest → ⑦ 仲裁 → ⑧ executeAtomic(move_to)。
   * priority 45 高于跟随(40)/采集(30)，确保主导。
   */
  injectMove(target: Loc, opts: { priority?: number; timeoutMs?: number; hard?: boolean } = {}): void {
    const tasks = this.runtime.tasks;
    if (!this.moveTaskId || !tasks.isRunning(this.moveTaskId)) {
      const task = tasks.createTask('benchmark_move', { source: 'eval.director' }, {
        priority: opts.priority ?? 45,
        label: 'Benchmark：移动原子评测',
      });
      const started = tasks.start(task.id, this.runtime.perception.perceive());
      if (!started.ok) {
        this.log(`[subject] benchmark_move start failed: ${started.reason ?? 'unknown'}`);
        return;
      }
      this.moveTaskId = task.id;
    }
    const req: ActionRequest = {
      id: `eval-move-${++this.reqSeq}`,
      source: 'eval.director',
      type: 'move_to',
      taskId: this.moveTaskId,
      priority: opts.priority ?? 45,
      interrupt_level: opts.hard ? 'hard' : 'soft',
      resource: ['movement'],
      target: { position: { x: target.x, y: target.y, z: target.z } },
      preconditions: [],
      timeout_ms: opts.timeoutMs ?? 30000,
    };
    this.runtime.heart.submitRequest(req);
  }

  /** 注入一个任务（follow_owner / gather_material / craft_item / farm），并立即 start */
  injectTask(kind: string, params: Record<string, unknown>, priority?: number): string {
    const world = this.runtime.perception.perceive();
    const task = this.runtime.tasks.createTask(kind, params, priority != null ? { priority } : undefined);
    const r = this.runtime.tasks.start(task.id, world);
    if (!r.ok) this.log(`[subject] injectTask ${kind} start failed: ${r.reason}`);
    return task.id;
  }

  /** 复位：结束所有任务 + 停导航（每次 repeat 之间调用，清场） */
  async reset(): Promise<void> {
    if (!this.v2) return;
    this.v2.cancelActiveTasks('eval_reset');
    this.moveTaskId = null;
    // Never start the next case until the shared body confirms native work has drained.
    // Unconfirmed cleanup fails reset instead of silently overlapping benchmark cases.
    await this.v2.body.drainAll('eval_reset');
    this.diedInRun = false;
  }

  // ─────────────── 探针（success 判定用） ───────────────

  pos(): Loc {
    const p = this.conn.gameAdapter.getPosition();
    return { x: p.x, y: p.y, z: p.z };
  }

  health(): number { return this.conn.gameAdapter.getHealth(); }

  /** 当前 repeat 是否发生过死亡；使用事件锁存，避免自动重生后 health=20 导致漏判。 */
  hasDiedSinceReset(): boolean { return this.diedInRun; }

  /** 当前饥饿值（FEAT-CROSS-03 · SURV 场景用） */
  food(): number { return this.conn.gameAdapter.getFood(); }

  /** 背包中某物品总数（支持后缀匹配，如 'log' 匹配所有 *_log） */
  invCount(nameOrSuffix: string): number {
    const items = this.conn.gameAdapter.getInventoryItems();
    return items
      .filter(it => it.name === nameOrSuffix || it.name.endsWith(`_${nameOrSuffix}`) || it.name.endsWith(nameOrSuffix))
      .reduce((s, it) => s + it.count, 0);
  }

  /** 距某世界坐标的 3D 距离 */
  distTo(loc: Loc): number {
    const p = this.pos();
    const dx = p.x - loc.x, dy = p.y - loc.y, dz = p.z - loc.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** 距某世界坐标的水平距离（忽略 y） */
  hdistTo(loc: Loc): number {
    const p = this.pos();
    const dx = p.x - loc.x, dz = p.z - loc.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** 是否存在指定 kind 的已完成任务 */
  hasCompletedTask(kind: string): boolean {
    return !!this.v2?.tasks.list().some(t => t.kind === kind && t.state === 'completed');
  }

  /** 清掉 move 结果记录（每次 repeat 开始前调，避免读到上轮残留） */
  clearMoveResult(): void { this.lastMove = null; }

  /** 最近一次 move_to 结束后是否「失败」（即放弃寻路）· 用于 NAV-05 */
  gaveUpSince(sinceMs: number): boolean {
    return !!this.lastMove && this.lastMove.ok === false && this.lastMove.at >= sinceMs;
  }
}
