/**
 * 🌳 GuardStrategy · BT 守卫策略（标杆实现）
 *
 * 树结构：
 *   Selector(root)
 *   ├─ Sequence(emergency)      ← 血量危急 → 立即停止
 *   ├─ Sequence(combat)         ← 有敌对实体 → 近战 + 风筝
 *   │   └─ Selector(combat_action)
 *   │       ├─ Sequence(kite)   ← 太近（< 2格）→ 后退
 *   │       └─ cooldown(attack) ← 正常距离 → 攻击
 *   └─ Sequence(patrol)         ← 无威胁 → 在守卫半径内巡逻
 *
 * 配置项（GuardConfig）：
 *   center    守卫中心坐标
 *   radius    巡逻半径（格）
 *   combatRange     触发战斗的最大距离（默认 8）
 *   kiteRange       触发后退的最近距离（默认 2.5）
 *   attackCooldownMs 攻击间隔（默认 1200ms）
 *   patrolCooldownMs 巡逻移动间隔（默认 8000ms）
 *   healthThreshold 血量危急阈值（默认 4）
 */

import { BtStrategy } from '../bt/BtStrategy.js';
import { seq, sel, cond, action, cooldown } from '../bt/runner.js';
import type { StrategyContext } from '../types.js';
import type { BtContext } from '../bt/nodes.js';
import type { ActionRequest, EntityView } from '../../types.js';

export interface GuardConfig {
  center: { x: number; y: number; z: number };
  radius: number;
  combatRange?: number;
  kiteRange?: number;
  attackCooldownMs?: number;
  patrolCooldownMs?: number;
  healthThreshold?: number;
}

export class GuardStrategy extends BtStrategy {
  readonly id = 'guard_strategy';

  private readonly cfg: Required<GuardConfig>;
  private reqSeq = 0;

  constructor(config: GuardConfig) {
    super();
    this.cfg = {
      combatRange: 8,
      kiteRange: 2.5,
      attackCooldownMs: 1200,
      patrolCooldownMs: 8000,
      healthThreshold: 4,
      ...config,
    };
    this.initTree(this.buildTree());
  }

  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskKind === 'guard';
  }

  // ── 树构建 ──────────────────────────────────────────────────

  private buildTree() {
    const cfg = this.cfg;

    return sel('guard_root', [

      // ① 血量危急 → 停止所有移动
      seq('emergency', [
        cond('health_critical', ctx => ctx.world.self.health <= cfg.healthThreshold),
        action('emergency_stop', ctx => this.buildStop(ctx)),
      ]),

      // ② 有敌对实体 → 战斗
      seq('combat', [
        cond('hostile_in_range', ctx => this.closestHostile(ctx) !== null),
        sel('combat_action', [

          // 太近 → 先后退（风筝）
          seq('kite', [
            cond('too_close', ctx => {
              const h = this.closestHostile(ctx);
              return h !== null && h.distance < cfg.kiteRange;
            }),
            cooldown(cfg.attackCooldownMs / 2, action('kite_retreat', ctx => {
              const h = this.closestHostile(ctx);
              if (!h) return null;
              return this.buildKiteRetreat(ctx, h);
            })),
          ]),

          // 正常距离 → 攻击
          cooldown(cfg.attackCooldownMs, action('attack_hostile', ctx => {
            const h = this.closestHostile(ctx);
            if (!h) return null;
            return this.buildAttack(ctx, h);
          })),
        ]),
      ]),

      // ③ 无威胁 → 守卫中心范围内巡逻
      seq('patrol', [
        cond('outside_patrol_zone', ctx => {
          const s = ctx.world.self.position;
          const dist = Math.hypot(s.x - cfg.center.x, s.z - cfg.center.z);
          return dist > cfg.radius * 0.6;
        }),
        cooldown(cfg.patrolCooldownMs, action('patrol_move', ctx => {
          return this.buildPatrolMove(ctx);
        })),
      ]),

    ]);
  }

  // ── 工具方法 ────────────────────────────────────────────────

  private closestHostile(ctx: BtContext): EntityView | null {
    let best: EntityView | null = null;
    for (const e of ctx.world.entities) {
      if (e.category !== 'hostile') continue;
      if (e.distance > this.cfg.combatRange) continue;
      if (!best || e.distance < best.distance) best = e;
    }
    return best;
  }

  // ── ActionRequest 构建器 ────────────────────────────────────

  private buildAttack(ctx: BtContext, hostile: EntityView): ActionRequest {
    const priority = hostile.distance < 3 ? 52 : 45;
    return {
      id: `guard-atk-${ctx.tick}-${++this.reqSeq}`,
      source: `${this.id}.attack`,
      type: 'invoke_behavior',
      priority,
      interrupt_level: hostile.distance < 3 ? 'hard' : 'soft',
      resource: ['movement', 'vision'],
      target: { behavior: 'combat', behaviorParams: { targetEntityId: hostile.id } },
      preconditions: [],
      expected_effect: ['hostile_damaged'],
      timeout_ms: 1200,
    };
  }

  private buildKiteRetreat(ctx: BtContext, hostile: EntityView): ActionRequest {
    const self = ctx.world.self.position;
    const dx = self.x - hostile.position.x;
    const dz = self.z - hostile.position.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const backoffDist = Math.max(this.cfg.kiteRange + 1, 3);
    return {
      id: `guard-kite-${ctx.tick}-${++this.reqSeq}`,
      source: `${this.id}.kite`,
      type: 'move_to',
      priority: 55,
      interrupt_level: 'hard',
      resource: ['movement'],
      target: {
        position: {
          x: Math.floor(self.x + (dx / len) * backoffDist),
          y: self.y,
          z: Math.floor(self.z + (dz / len) * backoffDist),
        },
      },
      preconditions: [],
      expected_effect: ['safe_distance_maintained'],
      timeout_ms: 3000,
    };
  }

  private buildPatrolMove(ctx: BtContext): ActionRequest {
    const { center, radius } = this.cfg;
    const angle = Math.random() * Math.PI * 2;
    const r = radius * (0.3 + Math.random() * 0.5);
    return {
      id: `guard-patrol-${ctx.tick}-${++this.reqSeq}`,
      source: `${this.id}.patrol`,
      type: 'move_to',
      priority: 35,
      interrupt_level: 'soft',
      resource: ['movement'],
      target: {
        position: {
          x: Math.floor(center.x + Math.cos(angle) * r),
          y: Math.floor(center.y),
          z: Math.floor(center.z + Math.sin(angle) * r),
        },
      },
      preconditions: [],
      expected_effect: ['patrolled_area'],
      timeout_ms: 12000,
    };
  }

  private buildStop(ctx: BtContext): ActionRequest {
    return {
      id: `guard-stop-${ctx.tick}-${++this.reqSeq}`,
      source: `${this.id}.emergency`,
      type: 'stop',
      priority: 90,
      interrupt_level: 'hard',
      resource: ['movement'],
      preconditions: [],
      timeout_ms: 200,
    };
  }
}
