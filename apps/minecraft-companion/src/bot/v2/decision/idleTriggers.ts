/**
 * 🪝 L7 · IdleTriggers（FEAT-L7-03 · 自驱工作流）
 *
 * IDLE 节拍时的"快脑"反射环。
 * 复用 mainBrain.buildIdleContext() 已就绪的 snapshot，命中硬条件直接 createTask + start，
 * 不必等 LLM IDLE turn 推理 5–30s。
 *
 * 规则：
 *   - trigger 按 priority 降序遍历，第一个命中即 return（互斥）
 *   - 有 running/paused 任务 → 整个 evaluator 短路（不抢主任务）
 *   - 命中后 setIdleCooldown(60s) 由 mainBrain 完成（这里只返回 cooldownMs）
 *   - trigger 只起"基础生存"类任务（食物 / 木头），不抢"思考类"决策
 *
 * 不在这里做：
 *   ❌ 重新构造 idleContext（用现成的）
 *   ❌ 调 LLM / Hermes
 *   ❌ 推迟/重试逻辑（mainBrain 冷却已处理）
 */

import type { EventBusV2 } from '../infra/eventBus.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import type { WorldStateView } from '../types.js';
import type { FailureReason } from '../task/failureReason.js';
import type { TriggerOutcomeMemory } from './triggerOutcomeMemory.js';
import { tuning } from '../infra/tuning.js';

/** mainBrain.buildIdleContext() 产出的 snapshot · 这里只看必要字段 */
export interface IdleContextSnapshot {
  pos: { x: number; y: number; z: number };
  hp: number;
  food: number;
  isDay: boolean;
  timeOfDay: number;
  invBrief: Array<{ name: string; count: number }>;
  threats: Array<{ name: string; distance: number }>;
  /** 其他字段（nearbyMobs / recentEvents / activeTask）evaluator 不需要 */
  [key: string]: unknown;
}

export interface IdleTriggerDeps {
  bus: EventBusV2;
  tasks: TaskRuntime;
  /** 现有 running/paused 任务数 · 非 0 → evaluator 短路 */
  getRunningTaskCount: () => number;
  /** 当前世界快照 · trigger 起任务时需要传给 tasks.start 做 preflight */
  getWorldState: () => WorldStateView | null;
  log: (m: string) => void;
  /** FEAT-L6-04 · 触发器结果记忆（连败退避 + escalate）· 不注入则不退避（兼容旧测试/无状态环境） */
  outcomes?: TriggerOutcomeMemory;
  /** FEAT-L6-04 · 连败 escalate 回调 · evaluator 命中"退避中且 escalate"时调用，让 mainBrain 强制唤醒慢脑 */
  onEscalate?: (info: { triggerId: string; reason: string; count: number }) => void;
}

export interface TriggerResult {
  triggerId: string;
  action: 'task_created' | 'say_only';
  taskId?: string;
  cooldownMs: number;
}

/** 食物物品名集合（用于 T-LOW-HP 检测 · T-LOW-FOOD 已禁用但保留集合供将来恢复） */
const FOOD_ITEMS = new Set<string>([
  'bread', 'cooked_beef', 'cooked_chicken', 'cooked_porkchop', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'apple', 'golden_apple', 'enchanted_golden_apple',
  'baked_potato', 'carrot', 'beetroot',
  'cookie', 'melon_slice', 'pumpkin_pie',
  // 生肉作为兜底
  'beef', 'chicken', 'porkchop', 'mutton', 'rabbit',
]);
/** 运行时可配 · 外勤 trigger 命中冷却 ms */
function cooldownMs(): number { return tuning().l6.triggerCooldownMs; }
/** 运行时可配 · 外勤 trigger 敌对实体安全半径（与 no_hostiles_nearby precondition 同口径） */
function hostileRadius(): number { return tuning().l6.hostileRadius; }

/**
 * FEAT-L6-04 · 立项前咨询触发器结果记忆。
 * 退避中 → 返回 false（跳过该 trigger，不短路其他低优 trigger）+ 日志/事件可见。
 */
function consultAllows(deps: IdleTriggerDeps, triggerId: string): boolean {
  const c = deps.outcomes?.consult(triggerId);
  if (!c || c.allow) return true;
  const remainSec = c.untilMs ? Math.max(0, Math.ceil((c.untilMs - Date.now()) / 1000)) : 0;
  deps.bus.publish('l7.trigger_backoff', 'info', {
    triggerId, reason: c.reason, untilMs: c.untilMs, escalate: !!c.escalate,
  });
  deps.log(`idle trigger ${triggerId} 退避中（${c.reason ?? '?'} · 剩 ${remainSec}s${c.escalate ? ' · escalate→移交慢脑' : ''}）· 跳过`);
  if (c.escalate) deps.onEscalate?.({ triggerId, reason: c.reason ?? '', count: c.count ?? 0 });
  return false;
}

function countInInv(inv: IdleContextSnapshot['invBrief'], names: Set<string>): number {
  let sum = 0;
  for (const it of inv) {
    if (names.has(it.name)) sum += it.count;
  }
  return sum;
}

/**
 * 主入口 · 评估所有 trigger，命中第一个即返回。
 *
 * 优先级序：T-LOW-HP > T-NIGHT > T-LOW-FOOD > T-GATHER-WOOD > null
 *
 * @returns 命中 → TriggerResult；未命中 → null（mainBrain 走原 LLM IDLE turn）
 */
export function evaluateIdleTriggers(
  ctx: IdleContextSnapshot,
  deps: IdleTriggerDeps,
): TriggerResult | null {
  // 短路 1：已有活跃任务 → 不抢
  if (deps.getRunningTaskCount() > 0) return null;

  // ─── T-LOW-HP (priority 100) ───
  // 阶段一：仅 say · 不动 atomic（吃食物 atomic 待 FEAT-L3-04 完善）
  if (ctx.hp < 8 && countInInv(ctx.invBrief, FOOD_ITEMS) > 0) {
    // FEAT-NARR-01 删假话：hp 低此前仅 say 未真吃 → 静默进冷却（真进食动作待 FEAT-L3-04）
    deps.bus.publish('l7.idle_trigger_fired', 'info', {
      triggerId: 'T-LOW-HP',
      action: 'say_only',
    });
    deps.log(`idle trigger fired · T-LOW-HP (hp=${ctx.hp})`);
    return { triggerId: 'T-LOW-HP', action: 'say_only', cooldownMs: cooldownMs() };
  }

  // ─── T-NIGHT-SHELTER (priority 90) ───
  // 阶段一：仅 say · seek_shelter 任务待后续 atomic 完善
  if (!ctx.isDay && ctx.timeOfDay >= 13000) {
    // FEAT-NARR-01 删假话：天黑此前仅 say 未真躲 → 静默进冷却
    deps.bus.publish('l7.idle_trigger_fired', 'info', {
      triggerId: 'T-NIGHT-SHELTER',
      action: 'say_only',
    });
    deps.log(`idle trigger fired · T-NIGHT-SHELTER (time=${ctx.timeOfDay})`);
    return { triggerId: 'T-NIGHT-SHELTER', action: 'say_only', cooldownMs: cooldownMs() };
  }

  // T-LOW-FOOD 和 T-GATHER-WOOD 已禁用：bot 不自动立项，由 LLM IDLE turn 自主决策

  // 没人命中 · 走原 LLM IDLE turn
  return null;
}

/** 内部：createTask + start · 失败回 reason */
function tryCreateAndStart(
  deps: IdleTriggerDeps,
  kind: string,
  params: Record<string, unknown>,
  overrides: { priority?: number; preconditions?: string[] },
): { ok: true; taskId: string } | { ok: false; reason: string } {
  const world = deps.getWorldState();
  if (!world) return { ok: false, reason: 'no_world_state' };
  try {
    const t = deps.tasks.createTask(kind, params, overrides);
    const r = deps.tasks.start(t.id, world);
    if (!r.ok) {
      // 起不来也要回滚——失败任务不残留在 list 中（FEAT-L6-04 · 结构化失败 code）
      const reasonStr = r.reason ?? 'start_failed';
      const fr: FailureReason = reasonStr.startsWith('preflight_missing')
        ? { code: 'precondition_failed', detail: reasonStr }
        : { code: 'start_failed', detail: reasonStr };
      try { deps.tasks.fail(t.id, fr); } catch { /* ignore */ }
      return { ok: false, reason: reasonStr };
    }
    return { ok: true, taskId: t.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }
}
