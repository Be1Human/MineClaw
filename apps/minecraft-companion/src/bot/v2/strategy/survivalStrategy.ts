/**
 * 🛡 SurvivalStrategy · 生存自保（每 tick 主动监控，最高优先级）
 *
 * 解决"濒死还硬核造物/被围殴呆站"问题——像人一样先保命。
 * 每 tick 检查威胁与血量，按需抢占当前任务：
 *   ① 自动进食：受伤 + 背包有食物 + 不在贴脸战斗 → 吃东西回血
 *   ② 主动拉距：敌怪进入危险半径 → 逃跑（保持距离，让自然回血生效）
 *   ③ 濒死撤离：血量 ≤ 临界 → 无条件逃跑
 *   ④ 反击：仅 1 个近敌 + 有剑 + 血量健康 → 打死它（不跟一群硬刚）
 *   ⑤ ★ 夜晚自保（FEAT-L5-02）：夜晚遇怪 + 背包有方块 → 在水平 4 向围掩体，挡住怪
 *
 * 威胁解除（附近无危险敌怪）时本策略静默 → 任务自然恢复。
 * 高优先级 ActionRequest 自动抢占 gather/craft 等低优任务（脑手一致：危险时手脚先避险）。
 */

import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest, EntityView } from '../types.js';
import type { TaskRuntime } from '../task/taskRuntime.js';

// ── 阈值 ──────────────────────────────────────────────
// FEAT-CROSS-05 · 生存自保统一注册一个 'survive' 紧急任务（任务树可见），优先级取其行动最高档
const SURVIVE_PRIORITY = 98;
const DANGER_RANGE = 14;        // 敌怪进入此半径 → 主动拉距（略大于骷髅射程）
const CRITICAL_HEALTH = 8;      // 濒死阈值 → 无条件逃
const EAT_HEALTH = 16;          // 低于此且有食物 → 进食（回血）
const HUNGER_EAT_FOOD = 17;     // 饥饿值低于此且有食物 + 安全 → 进食（维持自然回血，避免饿到掉血）
const FIGHT_HEALTH = 12;        // 高于此才考虑反击
const FIGHT_RANGE = 5;          // 仅打 5 格内的单个近敌
const FIGHT_CROWD_RANGE = 12;   // 12 格内有其它敌怪则不打（避免被群殴）
const SAY_COOLDOWN_MS = 8000;
// 被困判定：连续逃跑但与最近敌怪距离拉不开（如地下被墙堵住）→ 改为反击，
// 否则无限逃跑霸占执行锁、饿死生产任务（真服日志实证：地下 survival.flee 每 tick 霸占）。
const CORNERED_TICKS = 6;       // 连续 N tick 逃却拉不开距离 → 判定被困
const CORNERED_NO_GAIN = 0.8;   // 距离增量小于此视为"没拉开"

/** 不主动招惹的中立怪（不靠近就不打它/不逃）——避免对被动末影人乱跑 */
const PASSIVE_UNLESS_PROVOKED = new Set(['enderman']);

// ── FEAT-L5-02：夜晚自保参数 ─────────────────────────────────────
/** 夜晚搭掩体的方块白名单（按优先级排序：cobblestone > dirt > planks > stone） */
const SHELTER_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'stone',
  'dirt', 'grass_block', 'coarse_dirt',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
];
/** 围一圈需要的方块数（N/S/E/W 4 块） */
const SHELTER_BLOCK_COUNT = 4;
/** 围完后认为"已庇护"的持续 tick 数（避免每 tick 再围一遍） */
const SHELTER_HOLD_TICKS = 200; // ~20s（足以撑过一波怪的接近）

/** 常见食物物品（背包有则可进食回血） */
const FOODS = new Set([
  'bread', 'apple', 'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'baked_potato', 'carrot', 'golden_carrot', 'beetroot',
  'melon_slice', 'sweet_berries', 'glow_berries', 'dried_kelp',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie',
  'cookie', 'honey_bottle',
]);

const SWORD_SUFFIX = '_sword';

export class SurvivalStrategy implements IStrategy {
  readonly id = 'survival_strategy';
  readonly kind = 'reflex' as const;

  private seq = 0;
  private lastSayAt = 0;
  private lastMode = 'safe';
  // 被困追踪
  private fleeStuckTicks = 0;
  private lastNearest = Infinity;
  // FEAT-L5-02：夜晚自保状态
  private nightShelterIssuedTick = -1;     // 上次围掩体的 tick · -1 = 未围
  private nightShelterSayDoneOnce = false; // 当前夜晚是否已 say 过"没方块"提示

  /** FEAT-CROSS-05 · 当前 survive 紧急任务 id（null=安全无任务） */
  private taskId: string | null = null;

  constructor(
    /** FEAT-CROSS-05 · 生存反射也必须先注册紧急任务再执行 */
    private readonly tasks: TaskRuntime,
  ) {}

  /** 永远参与监控（每 tick 检查威胁） */
  isActive(_ctx: StrategyContext): boolean {
    return true;
  }

  /**
   * FEAT-CROSS-05 · 外层包紧急任务生命周期：有保命动作 → 确保 'survive' 紧急任务在 + 给请求打 taskId；
   * 安全无动作 → complete 该任务（自动恢复被抢占的 goto/follow）。内部 decide() 决策逻辑不变（保护战斗链路）。
   */
  tick(ctx: StrategyContext): ActionRequest[] {
    const reqs = this.decide(ctx);
    if (reqs.length > 0) {
      if (!this.taskId || !this.tasks.isRunning(this.taskId)) {
        const t = this.tasks.createTask('survive', {}, { priority: SURVIVE_PRIORITY });
        this.tasks.startEmergency(t.id);
        this.taskId = t.id;
      }
      for (const r of reqs) r.taskId = this.taskId;
      return reqs;
    }
    // 安全 · 无保命动作 → 结束 survive 任务（栈空时自动恢复原任务）
    if (this.taskId) { this.tasks.complete(this.taskId); this.taskId = null; }
    return [];
  }

  private decide(ctx: StrategyContext): ActionRequest[] {
    const self = ctx.world.self;
    const health = self.health;
    const food = self.food;

    // 危险敌怪（排除不招惹的中立怪 + 只看危险半径内）
    const dangerous = this.dangerousHostiles(ctx);
    const nearest = dangerous[0] ?? null;
    const nearestDist = nearest ? nearest.distance : Infinity;
    const combatIntent = ctx.activeTaskKind === 'goal_exec'
      && ctx.activeTaskParams?.combatIntent === true;

    // 被困追踪：在危险中却拉不开距离（地下/被墙堵）→ 累计；安全则清零
    const inDanger = nearestDist <= DANGER_RANGE;
    if (inDanger && nearestDist >= this.lastNearest - CORNERED_NO_GAIN) this.fleeStuckTicks++;
    else if (!inDanger) this.fleeStuckTicks = 0;
    this.lastNearest = nearestDist;
    // 被困：连续逃却拉不开 → 改为反击（逃也没用，不如拼了，且让出无限逃跑霸占的执行锁）
    const cornered = nearest != null && this.fleeStuckTicks >= CORNERED_TICKS;

    // FEAT-L5-02 · 白天 / 安全时清除夜晚自保的"已围"状态，让下一晚可重新围
    const isNight = !ctx.world.environment.isDay;
    if (!isNight || dangerous.length === 0) {
      if (this.nightShelterIssuedTick !== -1) {
        this.nightShelterIssuedTick = -1;
        this.nightShelterSayDoneOnce = false;
      }
    }

    // ── ① 自动进食 ──（受伤 或 饥饿 + 有食物 + 不在贴脸战斗）
    //   受伤进食：回血；饥饿进食：维持 food≥18 让自然回血生效，避免饿到掉血。
    const needEatForHealth = health < EAT_HEALTH;
    const needEatForHunger = food <= HUNGER_EAT_FOOD;
    if ((needEatForHealth || needEatForHunger) && food < 20 && nearestDist > 6) {
      const foodName = this.findFood(ctx);
      if (foodName) {
        this.lastMode = needEatForHealth ? 'eat_heal' : 'eat_hunger';
        return [this.eat(ctx, foodName)];
      }
    }

    // ── ③ 濒死撤离 ──（贴脸时先创造进食窗口）
    if (health <= CRITICAL_HEALTH && dangerous.length > 0) {
      if (cornered && !this.findFood(ctx)) {
        this.lastMode = 'fight_cornered';
        return this.fightWithSay(ctx, nearest!.id, { topic: 'danger_fight', urgency: 90 });
      }
      this.lastMode = 'flee_critical';
      return this.fleeWithSay(ctx, { topic: 'low_health', urgency: 95, data: { health: Math.round(health) } });
    }

    // 无危险敌怪 → 静默（让任务恢复）
    if (dangerous.length === 0) {
      this.lastMode = 'safe';
      return [];
    }

    // 健康的主动清怪由 CombatBehavior 持有控制权，避免通用生存策略反向抢占。
    if (combatIntent && health > CRITICAL_HEALTH) {
      this.lastMode = 'combat_managed';
      return [];
    }

    // ── ④ 反击：仅 1 个近敌 + 有剑 + 血量够 + 周围没别的怪 ──
    if (
      health > FIGHT_HEALTH &&
      nearest != null &&
      nearestDist <= FIGHT_RANGE &&
      this.hasSword(ctx) &&
      this.crowdCount(dangerous, FIGHT_CROWD_RANGE) <= 1
    ) {
      this.lastMode = 'fight';
      return this.fight(ctx, nearest.id);
    }

    // ── ⑤ 夜晚自保 ──（FEAT-L5-02 · 夜晚 + 危险 → 围 4 块掩体优于无脑逃）
    if (isNight && nearestDist <= DANGER_RANGE) {
      // 已经围过且仍在 hold 期内 → 静默蹲守，不再重复围（让出执行锁）
      if (this.nightShelterIssuedTick > 0 && ctx.tick - this.nightShelterIssuedTick < SHELTER_HOLD_TICKS) {
        this.lastMode = 'night_sheltered_idle';
        return [];
      }
      // 挑块 → 围
      const blk = this.findShelterBlock(ctx);
      if (blk && blk.count >= SHELTER_BLOCK_COUNT) {
        this.nightShelterIssuedTick = ctx.tick;
        this.lastMode = 'night_shelter';
        const out = this.buildShelter(ctx, blk.name);
        this.maybeSay(ctx, { topic: 'night_shelter', urgency: 70 });
        return out;
      }
      // 没方块 → fallthrough 走原 flee 路径，但带一句话提示（每晚一次）
      if (!this.nightShelterSayDoneOnce) {
        this.nightShelterSayDoneOnce = true;
        const out = this.fleeWithSay(ctx, { topic: 'danger_flee', urgency: 90, data: { mob: describeMob(nearest?.name) } });
        this.lastMode = 'flee';
        return out;
      }
      // fallthrough 到 ② 拉距
    }

    // ── ② 主动拉距 ──（敌怪进入危险半径 → 逃，保持距离回血）
    if (nearestDist <= DANGER_RANGE) {
      // 被困（逃不开）→ 反击，避免无限逃跑霸占执行锁、饿死生产任务
      if (cornered) {
        this.lastMode = 'fight_cornered';
        return this.fightWithSay(ctx, nearest!.id, { topic: 'danger_fight', urgency: 90, data: { mob: describeMob(nearest?.name) } });
      }
      this.lastMode = 'flee';
      const name = describeMob(nearest?.name);
      return this.fleeWithSay(ctx, { topic: 'danger_flee', urgency: 90, data: { mob: name } });
    }

    this.lastMode = 'safe';
    return [];
  }

  reset(): void {
    this.seq = 0;
    this.lastSayAt = 0;
    this.lastMode = 'safe';
    this.fleeStuckTicks = 0;
    this.lastNearest = Infinity;
    this.nightShelterIssuedTick = -1;
    this.nightShelterSayDoneOnce = false;
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
    return { kind: 'reflex', view: { mode: this.lastMode } };
  }

  // ── 内部 ──────────────────────────────────────────

  private dangerousHostiles(ctx: StrategyContext): EntityView[] {
    return ctx.world.entities
      .filter(e => e.category === 'hostile')
      .filter(e => !PASSIVE_UNLESS_PROVOKED.has(stripMob(e.name)))
      .filter(e => e.distance <= DANGER_RANGE + 4)
      .sort((a, b) => a.distance - b.distance);
  }

  private crowdCount(dangerous: EntityView[], range: number): number {
    return dangerous.filter(e => e.distance <= range).length;
  }

  private findFood(ctx: StrategyContext): string | null {
    for (const it of ctx.world.inventory.items) {
      if (FOODS.has(it.name)) return it.name;
    }
    return null;
  }

  private hasSword(ctx: StrategyContext): boolean {
    return ctx.world.inventory.items.some(i => i.name.endsWith(SWORD_SUFFIX));
  }

  // ── FEAT-L5-02 · 夜晚自保辅助 ─────────────────────────────────────

  /** 按白名单优先级挑掩体方块（cobblestone > dirt > planks > stone） */
  private findShelterBlock(ctx: StrategyContext): { name: string; count: number } | null {
    for (const name of SHELTER_BLOCKS) {
      const it = ctx.world.inventory.items.find(i => i.name === name);
      if (it && it.count >= 1) return { name, count: it.count };
    }
    return null;
  }

  /**
   * 围掩体：在 self 水平 N/S/E/W 4 个邻位放方块。
   * referencePosition 选 self 脚下偏移 1 格（即新方块下面那块地），faceVector = up。
   * 若脚下不是实方块（玩家浮空）→ place_block atomic 自然 fail；本策略下 tick 回退。
   * 每块 timeout=2s · 4 块总 ≤ 8s，绝不无限霸占执行锁。
   */
  private buildShelter(ctx: StrategyContext, blockName: string): ActionRequest[] {
    const self = ctx.world.self.position;
    const baseX = Math.floor(self.x);
    const baseY = Math.floor(self.y);
    const baseZ = Math.floor(self.z);
    const offsets: Array<{ dx: number; dz: number }> = [
      { dx:  1, dz:  0 },
      { dx: -1, dz:  0 },
      { dx:  0, dz:  1 },
      { dx:  0, dz: -1 },
    ];
    const out: ActionRequest[] = [];
    for (const o of offsets) {
      out.push({
        id: `${this.id}-shelter-${ctx.tick}-${++this.seq}`,
        source: `${this.id}.night_shelter`,
        type: 'place_block',
        priority: 95,
        interrupt_level: 'hard',
        resource: ['inventory', 'movement'],
        target: {
          itemName: blockName,
          // 参考方块 = self 脚下 + 水平偏移（即新方块下方那块地）
          referencePosition: { x: baseX + o.dx, y: baseY - 1, z: baseZ + o.dz },
          // 法向量 up：在参考方块的上表面贴一块（与玩家同高，挡住怪的视线/路径）
          faceVector: { x: 0, y: 1, z: 0 },
          // 显式给最终位置，便于 lookAt
          position: { x: baseX + o.dx, y: baseY, z: baseZ + o.dz },
        },
        preconditions: [],
        expected_effect: ['shelter_built'],
        timeout_ms: 2000, // 每块 ≤ 2s · 4 块总 ≤ 8s
      });
    }
    return out;
  }

  private fleeWithSay(ctx: StrategyContext, intent: { topic: string; urgency: number; data?: Record<string, unknown> }): ActionRequest[] {
    const out: ActionRequest[] = [{
      id: `${this.id}-flee-${ctx.tick}-${++this.seq}`,
      source: `${this.id}.flee`,
      type: 'invoke_behavior',
      priority: 96,
      interrupt_level: 'hard',
      resource: ['movement'],
      target: { behavior: 'flee', behaviorParams: { fleeDistance: 22 } },
      preconditions: [],
      expected_effect: ['safe_distance'],
      timeout_ms: 8000,
    }];
    this.maybeSay(ctx, intent);
    return out;
  }

  private fight(ctx: StrategyContext, entityId: number): ActionRequest[] {
    return [{
      id: `${this.id}-fight-${ctx.tick}-${++this.seq}`,
      source: `${this.id}.fight`,
      type: 'invoke_behavior',
      priority: 98,
      interrupt_level: 'hard',
      resource: ['movement', 'vision'],
      target: { behavior: 'combat', behaviorParams: { targetEntityId: entityId } },
      preconditions: [],
      expected_effect: ['hostile_damaged'],
      timeout_ms: 4000,
    }];
  }

  /** 被困反击（含一句话）· combat 技能会就近接敌+挥击（无武器则空手） */
  private fightWithSay(ctx: StrategyContext, entityId: number, intent: { topic: string; urgency: number; data?: Record<string, unknown> }): ActionRequest[] {
    const out = this.fight(ctx, entityId);
    this.maybeSay(ctx, intent);
    return out;
  }

  private eat(ctx: StrategyContext, foodName: string): ActionRequest {
    return {
      id: `${this.id}-eat-${ctx.tick}-${++this.seq}`,
      source: `${this.id}.eat`,
      // FEAT-L3-02: 用专门的 eat atomic（bot.consume() 完整吃完）· 旧 use_tool 只 hold 150ms 吃不掉
      type: 'eat',
      priority: 94,
      interrupt_level: 'soft',
      resource: ['inventory'],
      target: { itemName: foodName },
      preconditions: [],
      expected_effect: ['health_restored', 'hunger_restored'],
      timeout_ms: 3000,
    };
  }

  // FEAT-NARR-01：不再发情绪化 say · 改为经统一语言中枢上报中性事件通知（保留冷却作预过滤）
  private maybeSay(ctx: StrategyContext, intent: { topic: string; urgency: number; data?: Record<string, unknown> }): void {
    const now = Date.now();
    if (now - this.lastSayAt < SAY_COOLDOWN_MS) return;
    this.lastSayAt = now;
    ctx.narrate?.({ source: 'survival', topic: intent.topic, urgency: intent.urgency, data: intent.data });
  }
}

function stripMob(name: string): string {
  return (name || '').toLowerCase();
}
function describeMob(name?: string): string {
  const n = (name || '').toLowerCase();
  if (n.includes('creeper')) return '苦力怕';
  if (n.includes('zombie')) return '僵尸';
  if (n.includes('skeleton')) return '骷髅';
  if (n.includes('spider')) return '蜘蛛';
  if (n.includes('witch')) return '女巫';
  if (n.includes('enderman')) return '末影人';
  return '怪';
}
