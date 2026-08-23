/**
 * ⚡ ReflexStrategy · 事件驱动 · 反射
 *
 * kind = 'reflex'
 *
 * 订阅 EventBus Critical 事件 · 命中规则 → 输出高优先级 ActionRequest
 *
 * 规则（FEAT-L3-01 改造后）：
 *   - under_attack + 非战斗任务 → 逃跑（flee P97）
 *   - under_attack + 战斗任务（guard/combat）→ 反击最近 hostile（attack P99）
 *   - health ≤ 6 + 非战斗 → 仍然逃跑（不再 stop 等死）
 *   - health ≤ 6 + 战斗 → 单一撤离动作（不同时攻击/停止）
 *
 * inspect() 返回：{ kind:'reflex', view: { pendingCount, lastTriggered } }
 */

import type { IEventDrivenStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest, BusEvent, EntityView } from '../types.js';
import type { TaskRuntime } from '../task/taskRuntime.js';

/** 视为"战斗任务"的 taskKind 白名单 */
const COMBAT_TASK_KINDS = new Set(['guard', 'combat']);
/** FEAT-CROSS-05 · 反射反应统一注册一个 'reflex_react' 紧急任务（任务树可见） */
const REFLEX_PRIORITY = 99;

export class ReflexStrategy implements IEventDrivenStrategy {
  readonly id = 'reflex_strategy';
  readonly kind = 'reflex' as const;

  /** 本 tick 内积累的 Critical 事件 · Heartbeat ② DrainEvents 后塞进来 */
  private pendingCritical: BusEvent[] = [];
  private reqSeq = 0;
  private lastTriggeredAt = 0;
  private lastTriggeredType = '';
  /** FEAT-CROSS-05 · 当前 reflex_react 紧急任务 id */
  private taskId: string | null = null;

  constructor(
    /** FEAT-CROSS-05 · 反射也必须先注册紧急任务再执行 */
    private readonly tasks: TaskRuntime,
  ) {}

  /** Heartbeat ② DrainEvents 后调用 · 把 Critical 事件塞进来 */
  ingestCritical(events: BusEvent[]): void {
    for (const ev of events) {
      if (ev.level === 'critical') this.pendingCritical.push(ev);
    }
  }

  /** EventBus 实时戳进 · 可选用 · 当前主路径走 ingestCritical + tick */
  onEvent(event: BusEvent, _ctx: StrategyContext): ActionRequest[] {
    if (event.level !== 'critical') return [];
    this.pendingCritical.push(event);
    return [];
  }

  isActive(_ctx: StrategyContext): boolean {
    return this.pendingCritical.length > 0;
  }

  /**
   * FEAT-CROSS-05 · 外层包紧急任务生命周期：有反射动作 → 确保 'reflex_react' 紧急任务 + 打 taskId；
   * 本 tick 无反应 → complete（栈空自动恢复原任务）。内部 decide() 反射决策逻辑不变。
   */
  tick(ctx: StrategyContext): ActionRequest[] {
    const reqs = this.decide(ctx);
    if (reqs.length > 0) {
      if (!this.taskId || !this.tasks.isRunning(this.taskId)) {
        const t = this.tasks.createTask('reflex_react', {}, { priority: REFLEX_PRIORITY });
        this.tasks.startEmergency(t.id);
        this.taskId = t.id;
      }
      for (const r of reqs) r.taskId = this.taskId;
      return reqs;
    }
    if (this.taskId) { this.tasks.complete(this.taskId); this.taskId = null; }
    return [];
  }

  private decide(ctx: StrategyContext): ActionRequest[] {
    if (this.pendingCritical.length === 0) return [];
    const events = this.pendingCritical;
    this.pendingCritical = [];

    const out: ActionRequest[] = [];
    let sayEmitted = false;

    for (const ev of events) {
      if (ev.type === 'under_attack') {
        // BUG-CROSS-04：持续烧伤也会产生 under_attack。当前若正在确定性的岩浆逃生，
        // 通用受击反射不得再建 P99 任务把 lava_escape 抢掉，否则两套保命动作互相打断。
        if (ctx.activeTaskKind === 'lava_escape') continue;
        const taskKind = ctx.activeTaskKind;
        const isCombatTask = (taskKind != null && COMBAT_TASK_KINDS.has(taskKind))
          || (taskKind === 'goal_exec' && ctx.activeTaskParams?.combatIntent === true);
        const health = ctx.world.self.health;

        const attackerId = pickClosestHostile(ctx);
        const attackerName = attackerId != null
          ? ctx.world.entities.find(e => e.id === attackerId)?.name ?? '怪'
          : null;

        if (isCombatTask) {
          // 低血时只撤离，不能同时输出 P99 攻击和 P95 停止。
          if (health <= 6) {
            out.push(this.buildFlee(ctx));
          } else if (attackerId != null) {
            out.push(this.buildAttack(ctx, attackerId));
          }
          if (!sayEmitted) {
            // FEAT-NARR-01：不再硬编码喊话，上报结构化意图经 NarrationHub 统一渲染/出口/去重
            ctx.narrate?.({
              source: 'survival',
              topic: health <= 6 ? 'low_health' : 'danger_fight',
              urgency: health <= 6 ? 85 : 80,
              data: { mob: describeAttacker(attackerName), health: Math.round(health) },
              dedupeKey: 'under_attack',
            });
            sayEmitted = true;
          }
        } else {
          // ── 非战斗任务：逃跑 ──（FEAT-L3-01）
          out.push(this.buildFlee(ctx));
          if (!sayEmitted) {
            ctx.narrate?.({
              source: 'survival',
              topic: 'danger_flee',
              urgency: 80,
              data: { mob: describeAttacker(attackerName) },
              dedupeKey: 'danger_flee',
            });
            sayEmitted = true;
          }
        }
      }
    }

    if (out.length > 0) {
      this.lastTriggeredAt = Date.now();
      this.lastTriggeredType = events[0]?.type ?? '';
    }

    return out;
  }

  reset(): void {
    this.pendingCritical = [];
    this.lastTriggeredAt = 0;
    this.lastTriggeredType = '';
  }

  suspend(): void {
    if (this.taskId) {
      const task = this.tasks.getById(this.taskId);
      if (task && (task.state === 'running' || task.state === 'paused')) {
        this.tasks.cancel(task.id, 'automatic_defense_disabled');
      }
      this.taskId = null;
    }
    this.reset();
  }

  inspect(): StrategyInspect {
    return {
      kind: 'reflex',
      view: {
        pendingCriticalCount: this.pendingCritical.length,
        lastTriggeredAt: this.lastTriggeredAt,
        lastTriggeredType: this.lastTriggeredType,
      },
    };
  }

  // ── ActionRequest 构建 ──────────────────────────────────────

  /** 战斗任务：反击最近 hostile */
  private buildAttack(ctx: StrategyContext, entityId: number): ActionRequest {
    return {
      id: `reflex-attack-${ctx.tick}-${++this.reqSeq}`,
      source: `${this.id}.damage_revenge`,
      type: 'invoke_behavior',
      priority: 99,
      interrupt_level: 'hard',
      resource: ['movement', 'vision'],
      target: { behavior: 'combat', behaviorParams: { targetEntityId: entityId } },
      preconditions: [],
      expected_effect: ['attacker_damaged'],
      timeout_ms: 600,
    };
  }

  /** 非战斗任务：逃跑（FEAT-L3-01） */
  private buildFlee(ctx: StrategyContext): ActionRequest {
    return {
      id: `reflex-flee-${ctx.tick}-${++this.reqSeq}`,
      source: `${this.id}.flee`,
      type: 'invoke_behavior',
      priority: 97,
      interrupt_level: 'hard',
      resource: ['movement'],
      target: { behavior: 'flee', behaviorParams: { fleeDistance: 20 } },
      preconditions: [],
      expected_effect: ['safe_distance'],
      timeout_ms: 8000,
    };
  }

}

// ──────────────────────────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────────────────────────

function pickClosestHostile(ctx: StrategyContext): number | null {
  let best: EntityView | null = null;
  for (const e of ctx.world.entities) {
    if (e.category !== 'hostile') continue;
    if (e.distance > 16) continue;
    if (!best || e.distance < best.distance) best = e;
  }
  return best?.id ?? null;
}

function describeAttacker(name: string | null): string {
  if (!name) return '怪';
  if (name.includes('creeper'))  return '苦力怕';
  if (name.includes('zombie'))   return '僵尸';
  if (name.includes('skeleton')) return '骷髅';
  if (name.includes('spider'))   return '蜘蛛';
  if (name.includes('enderman')) return '末影人';
  if (name.includes('witch'))    return '女巫';
  return name;
}
