/**
 * L6 · StrategyMatcher —— GoalAgent 求解入口的「查库」一步（FEAT-CROSS-07 R4）
 *
 * resolve(goal, world) → {strategy, bind} | null：
 *   1 物品目标作用域硬过滤
 *   2 关键词预筛和确定性抽参
 *   3 applicability 硬门控（preconditions / appliesTo）
 *   4 目标安全闸（target 类别 ∈ excludes → 直接拒）
 * 命中后只生成 GoalAgent Actor 可选候选；未命中时继续由同一 GoalAgent 上下文决策。
 */

import type { Goal } from '../contracts/goalTypes.js';
import type { Strategy } from './strategyTypes.js';
import type { WorldStateView } from '../../types.js';

export interface MatchResult { strategy: Strategy; bind: Record<string, unknown>; }

export interface MatcherDeps {
  usable: () => Strategy[];
  /** applicability.preconditions 谓词（复用 PreconditionRegistry） */
  checkPredicate?: (name: string, world: WorldStateView) => boolean;
  /** 目标安全归类：给 bind（含 target），返回其类别标签（如 ['owner']/['hostile_entity','player']） */
  categorizeTarget?: (bind: Record<string, unknown>, world: WorldStateView) => string[];
  onLog?: (m: string) => void;
}

export class StrategyMatcher {
  constructor(private readonly deps: MatcherDeps) {}

  async resolve(goal: Goal, world: WorldStateView | null): Promise<MatchResult | null> {
    const all = this.deps.usable();
    if (all.length === 0) return null;

    // 结构化 item 是当前执行目标。registry 作用域必须在 LLM 前硬过滤，
    // 防止父目标文本或语义选择把“交付火把”策略带入“放置工作台”等目标。
    const registryTargets = extractRegistryGoalTargets(goal);
    const scoped = all.filter(strategy => registryScopeMatches(strategy, registryTargets));
    if (scoped.length === 0) {
      this.deps.onLog?.(`[matcher] registry 目标 ${registryTargets.join('/')} 无适用 Strategy → 降级 slow`);
      return null;
    }

    // 1 预筛
    const pre = scoped.filter(s => keywordOverlap(goal.goalText, `${s.name} ${s.description}`));
    const candidates = pre.length ? pre : scoped;

    // 2 确定性抽参。GoalAgent Actor 会在包含策略/行为/原子的完整候选表上做 LLM 选择。
    const selected = candidates[0];
    const picked = selected ? {id:selected.id,bind:heuristicBind(goal,selected)} : null;
    if (!picked) return null;
    const strategy = candidates.find(s => s.id === picked!.id);
    if (!strategy) {
      this.deps.onLog?.(`[matcher] picked id ${picked.id} 不在当前叶子的候选白名单`);
      return null;
    }
    if (!registryScopeMatches(strategy, registryTargets)) {
      this.deps.onLog?.(`[matcher] ${strategy.id} 物品作用域与 ${registryTargets.join('/')} 不匹配`);
      return null;
    }

    const app = strategy.applicability;

    // 3 前置硬门控
    if (app.preconditions?.length && (!world || !this.deps.checkPredicate)) {
      this.deps.onLog?.(`[matcher] ${strategy.id} 声明了前置谓词但生产检查器不可用，拒绝执行`);
      return null;
    }
    if (world && app.preconditions?.length && this.deps.checkPredicate) {
      for (const p of app.preconditions) {
        if (!this.deps.checkPredicate(p, world)) { this.deps.onLog?.(`[matcher] ${strategy.id} 前置 ${p} 不满足`); return null; }
      }
    }

    // 4 目标安全闸（红线）
    if (world && this.deps.categorizeTarget && (app.excludes?.length || app.appliesTo?.length)) {
      const cats = this.deps.categorizeTarget(picked.bind, world);
      if (app.excludes?.length) {
        const bad = cats.find(c => app.excludes!.includes(c));
        if (bad) { this.deps.onLog?.(`[matcher] ${strategy.id} 安全闸拒绝：target 是 ${bad}`); return null; }
      }
      if (app.appliesTo?.length && cats.length && !cats.some(c => app.appliesTo!.includes(c))) {
        this.deps.onLog?.(`[matcher] ${strategy.id} target 类别 ${cats.join('/')} 不在 appliesTo`);
        return null;
      }
    }

    return { strategy, bind: picked.bind };
  }
}

// ── helpers ──────────────────────────────────────────────
const STOP = new Set(['的', '了', '一', '个', '把', '去', '到', '帮', '我', '一下', '一顿']);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[\s,，。、!！?？]+/).flatMap(w => w.split('')).filter(c => c.trim() && !STOP.has(c));
}

/** 关键词重叠：粗粒度（中文按字 + 英文按词）有交集即过预筛 */
export function keywordOverlap(a: string, b: string): boolean {
  const ta = new Set(tokens(a));
  const tb = tokens(b);
  return tb.some(t => ta.has(t));
}

/** 启发式抽参：从 successCriteria(entity_dead) / context 抽 target */
export function heuristicBind(goal: Goal, strategy?: Strategy): Record<string, unknown> {
  const bind: Record<string, unknown> = {};
  const ed = (goal.successCriteria ?? []).find(c => c.type === 'entity_dead');
  if (ed) bind.target = ed.entityId ?? ed.entityName;
  const reach = (goal.successCriteria ?? []).find(c => c.type === 'reached');
  if (reach?.position) bind.position = reach.position;
  const scopes = (strategy?.applicability.appliesTo ?? [])
    .map(normalizeDeclaredRegistryTarget)
    .filter((item):item is string=>item!==null);
  const inventories = (goal.successCriteria ?? []).filter(c => c.type === 'inventory');
  const inv = scopes.length
    ? inventories.find(criterion=>{
        const target=normalizeRegistryTarget(criterion.item);
        return target!==null&&scopes.includes(target);
      })
    : inventories[0];
  if (inv) { bind.item = inv.item; bind.count = inv.count; }
  return bind;
}

const REGISTRY_TARGET = /^(?:minecraft|mineclaw):[a-z0-9_.\/-]+$/i;

/** 只读取当前叶子的结构化 inventory 判据；不读取父目标文本或 planner context。 */
export function extractInventoryGoalTargets(goal: Goal): string[] {
  const targets = (goal.successCriteria ?? [])
    .filter(criterion => criterion.type === 'inventory')
    .map(criterion => normalizeRegistryTarget(criterion.item))
    .filter((item): item is string => item !== null);
  return [...new Set(targets)];
}

export function extractRegistryGoalTargets(goal: Goal): string[] {
  const targets = (goal.successCriteria ?? [])
    .filter(criterion => criterion.type !== 'predicate' && criterion.type !== 'reached' && criterion.type !== 'entity_dead')
    .map(criterion => normalizeRegistryTarget(criterion.item))
    .filter((item): item is string => item !== null);
  return [...new Set(targets)];
}

function registryScopeMatches(strategy: Strategy, registryTargets: string[]): boolean {
  if (registryTargets.length === 0) return true;
  const declaredScopes = (strategy.applicability.appliesTo ?? [])
    .map(normalizeDeclaredRegistryTarget)
    .filter((item): item is string => item !== null);
  const registryScopes = [...new Set([...declaredScopes, ...literalStrategyItemScopes(strategy)])];
  if (registryScopes.length === 0) return true;
  return registryScopes.some(scope => registryTargets.includes(scope));
}

function literalStrategyItemScopes(strategy: Strategy): string[] {
  const values: string[] = [];
  const visit = (node: Strategy['bt']): void => {
    const args = 'args' in node && node.args && typeof node.args === 'object' ? node.args : null;
    for (const key of ['item', 'itemName']) {
      const value = args?.[key];
      if (typeof value !== 'string' || value.includes('{') || value.includes('$')) continue;
      const normalized = normalizeRegistryTarget(value);
      if (normalized) values.push(normalized);
    }
    if (node.type === 'sequence' || node.type === 'fallback') node.children.forEach(visit);
    if (node.type === 'condition' && node.fallback) visit(node.fallback);
    if (node.type === 'loop') visit(node.child);
  };
  visit(strategy.bt);
  return [...new Set(values)];
}

function normalizeDeclaredRegistryTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return REGISTRY_TARGET.test(normalized) ? normalized : null;
}

function normalizeRegistryTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const namespaced = normalized.includes(':') ? normalized : `minecraft:${normalized}`;
  return REGISTRY_TARGET.test(namespaced) ? namespaced : null;
}
