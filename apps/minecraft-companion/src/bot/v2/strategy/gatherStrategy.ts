/**
 * 📋 GatherStrategy · 任务驱动 · 就地采集
 *
 * kind = 'gather_material'   params: { material, count, maxDistance? }
 *
 * 每 tick：
 *   1. 库存已达标 → complete + say
 *   2. 附近有掉落物 → move_to 拾取（解决"挖了没捡"）
 *   3. 否则 findBlocks 最近源方块 → invoke_behavior(gather_block)（必要时先 equip 工具）
 *   4. 连续找不到资源 → fail + say（不死循环）
 *
 * 持有 GameAdapter（构造注入）以便 findBlocks / getEntities / getItemSource。
 */

import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest } from '../types.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import type { FailureReason } from '../task/failureReason.js';
import type { Vec3 } from '../../adapter/types.js';
import { invCount, hasToolFor, toolCategory, toolTierRank } from '../knowledge/recipeResolver.js';

const DEFAULT_MAX_DIST = 32; // BUG 修复：64→32 · 远树致 A* 算路/走路双超时空转，只挑近且算得动的目标
const DROP_PICKUP_RANGE = 6;
const STALL_TICKS = 600;    // 无库存增长容忍 tick（~120s）· 探索期更长，别误杀
const PICKUP_NOGAIN_LIMIT = 4; // 连续走向掉落物却没捡到的上限 → 暂停拾取回去挖矿
const EXPLORE_AFTER_MISS = 3;  // 连续 N 次没找到资源 → 移动到新区域再找
const MAX_EXPLORE = 8;          // BUG 修复：16→8 · 全不可达时更快收手，少空转刷屏
const EXPLORE_DIST = 40;        // 每次探索移动距离（格）· 调大覆盖更广（资源不在本地时能走到）
const MAX_DIGDOWN = 4;          // 竖直下挖最多深度（格）· 防越挖越深自埋；到顶交给 EscapeStrategy 爬出
/** 进入常规方块交互距离后，可达性应按当前位置重判，旧导航黑名单不再成立。 */
export const DIRECT_INTERACTION_RANGE = 4.5;

// FEAT-L5：木头按类型互换采集（任何原木都能做木板）。解决"resolver 选了 cherry_log，
// 而此世界只有 oak → 死找 cherry 永远失败"的真服 bug：采集 *_log 时找/算"任意原木"。
const ALL_LOGS = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'crimson_stem', 'warped_stem',
];
function isLogMaterial(name: string): boolean {
  return /_log$|_stem$/.test(name);
}

/** 矿石类方块（多嵌在石头里，需挖隧道凿过去，不能只 move_to）· FEAT 嵌石矿开采 */
function isOreBlock(name: string): boolean {
  return /_ore$|^ancient_debris$/.test(name || '');
}

export class GatherStrategy implements IStrategy {
  readonly id = 'gather_strategy';
  readonly kind = 'fsm' as const;

  private seq = 0;
  private missStreak = 0;
  private sinceTick = 0;
  private lastPhase = 'idle';
  // BUG-L5-03: 记录上次处理的 task.id · 任务切换时必须重置 per-task 状态，
  // 否则旧 lastProgressTick 残留 → 新任务一启动就被 stall 看门狗误判"长时间无进展"秒失败
  private lastTaskId = '';
  // 无进展看门狗
  private lastHave = -1;
  private lastProgressTick = 0;
  // 拾取无收益保护：连续走向掉落物却没捡到 → 暂时放弃拾取，回去挖矿
  private pickupNoGain = 0;
  // 不可达方块短期黑名单（key=坐标 → 解禁时间戳）· 移动超时/无路时拉黑，改试下一个候选
  private unreachable = new Map<string, number>();
  private lastTargetKey = '';
  // 假成功不可达检测：盯同一目标却没移动没采到的次数 + 上次盯它时的位置/库存
  private lastTargetBotPos: { x: number; y: number; z: number } | null = null;
  private lastHaveAtTarget = -1;
  private targetNoProgress = 0;
  // 探索：附近找不到资源时移动到新区域再找
  private exploreAttempts = 0;
  private lastExploreSayAt = 0;
  // 竖直下挖深度上限：记录开始下挖时的地表 Y，防止越挖越深把自己埋死（脱困交给 EscapeStrategy）
  private digDownBaseY: number | null = null;

  constructor(
    private readonly game: GameAdapter,
    private readonly bus: EventBusV2,
    private readonly tasks: TaskRuntime,
  ) {
    // 采集移动失败（nav_timeout / 无路 / frontier 卡死）→ 把刚才那个目标块短期拉黑，
    // 下个周期改试别的候选块。复杂地形里"最近的那块够不到"时不再死磕同一块。
    this.bus.on('exec.fail', ev => {
      const p = ev.payload as { source?: string; error?: string };
      if (p.source !== this.id) return;
      if (!this.lastTargetKey) return;
      // 覆盖各类"够不到/路径算不出"的失败串（含 pathfinder thinkTimeout "Took too long to decide path"）
      if (/nav_timeout|Path was stopped|frontier|no_advance|unreachable|noPath|too long|decide path|GoalChanged|timeout|nav_failed|dig_failed/i.test(p.error ?? '')) {
        this.unreachable.set(this.lastTargetKey, Date.now() + 30000); // 拉黑 30s
        this.lastTargetKey = '';
      }
    });
  }

  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskKind === 'gather_material';
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    const t = this.tasks.active();
    if (!t || t.kind !== 'gather_material') return [];

    // BUG-L5-03: 新任务（task.id 变了）→ 重置 per-task 追踪，避免旧状态导致秒 stall
    if (t.id !== this.lastTaskId) {
      this.lastTaskId = t.id;
      this.sinceTick = 0;
      this.missStreak = 0;
      this.lastPhase = 'idle';
      this.lastHave = -1;
      this.lastProgressTick = 0;
      this.pickupNoGain = 0;
      this.unreachable.clear();
      this.lastTargetKey = '';
      this.exploreAttempts = 0;
      this.lastExploreSayAt = 0;
    }

    const material = String(t.params.material ?? '');
    const count = Math.max(1, Number(t.params.count ?? 1));
    const maxDist = Number(t.params.maxDistance ?? DEFAULT_MAX_DIST);
    if (!material) { this.finishFail(t.id, { code: 'no_resource_found', detail: '未指定采集材料' }); return []; }

    if (this.sinceTick === 0) { this.sinceTick = ctx.tick; this.lastProgressTick = ctx.tick; }

    // 木头类型互换：采 *_log 时把"任意原木"都算进度、都作为可采目标
    const logMode = isLogMaterial(material);

    // 1) 达标 → 完成（木头模式按"所有原木"求和，oak/birch… 都算数）
    const have = logMode
      ? ALL_LOGS.reduce((s, n) => s + invCount(ctx.world.inventory, n), 0)
      : invCount(ctx.world.inventory, material);
    // 写任务进度（WebUI 任务树展示 have/count）
    t.progress = { ...(t.progress ?? {}), have, count };
    // FEAT-WEBUI-08 · 当前动作（NPC 行为）· lastPhase 滞后一 tick 可接受
    ctx.setPhase?.(
      this.lastPhase === 'collecting' ? '拾取掉落物'
        : this.lastPhase === 'digdown' ? `下挖 ${zhMaterial(material)}`
          : `挖掘 ${zhMaterial(material)} ${have}/${count}`,
    );

    // 无进展看门狗：长时间库存不增 → 放弃（防挖不动/够不到死循环）
    if (have > this.lastHave) {
      this.lastHave = have; this.lastProgressTick = ctx.tick; this.pickupNoGain = 0;
      this.exploreAttempts = 0; // 采到了 → 重置探索计数
      this.bus.publish('gather.progress', 'info', { material, have, count, done: have >= count });
    }
    if (ctx.tick - this.lastProgressTick > STALL_TICKS) {
      this.finishFail(t.id, { code: 'stall_no_progress', detail: `采集 ${material} 长时间无进展` });
      return []; // FEAT-NARR-01: 过程播报(🟡)已砍 · 失败由任务状态体现
    }

    if (have >= count) {
      this.lastPhase = 'done';
      this.bus.publish('gather.progress', 'info', { material, have, count, done: true });
      this.tasks.complete(t.id);
      ctx.narrate?.({ source: 'gather', topic: 'gather_done', urgency: 40, data: { material: zhMaterial(material), have } });
      return [];
    }

    // 源方块 + 工具门槛
    const src = this.game.getItemSource(material);
    const blockName = src?.block ?? material;
    const requiredTool = src?.requiredTool ?? null;

    let toolName: string | undefined;
    if (requiredTool) {
      toolName = findToolInInv(ctx.world.inventory.items.map(i => i.name), requiredTool);
      if (!toolName) {
        this.finishFail(t.id, { code: 'no_tool', detail: `需要${zhTool(requiredTool)}才能采集${zhMaterial(material)}` });
        ctx.narrate?.({ source: 'gather', topic: 'gather_no_tool', urgency: 50, data: { tool: zhTool(requiredTool), material: zhMaterial(material) } });
        return [];
      }
    }

    // 2) 优先拾取附近掉落物（带"无收益"保护，避免对捡不到的掉落物死循环）
    if (this.pickupNoGain < PICKUP_NOGAIN_LIMIT) {
      const drop = this.findNearbyDrop(ctx.world.self.position);
      if (drop) {
        this.lastPhase = 'collecting';
        this.missStreak = 0;
        this.pickupNoGain++; // 走过去后若 have 没涨，下次 tick 此计数不清零 → 达上限即放弃拾取
        return [this.moveTo(ctx, drop, 'pickup')];
      }
    }

    // 3) 找最近源方块（取多个候选，跳过短期判定不可达的，复杂地形里改试别的块）
    //    木头模式：搜"任意原木"，砍到 oak 即可（之后 resolver 会自动改用 oak 配方）。
    this.cleanUnreachable();
    const searchNames = logMode ? ALL_LOGS : blockName;
    const candidates = this.game.findBlocks({ names: searchNames, maxDistance: maxDist, count: 8 });
    const selfPosition = ctx.world.self.position;
    const reachable = candidates.filter(p => isGatherCandidateEligible(p, selfPosition, this.unreachable));
    // 木头模式：优先挖"最低的原木"（树干基部，从地面就够得到），
    //   避免去够漂在树顶的高处原木 → pathfinder 上不去、反复 nav_timeout 空转。
    if (logMode && reachable.length > 1) {
      const self = ctx.world.self.position;
      reachable.sort((a, b) => (a.y - b.y) || (distXZ(a, self) - distXZ(b, self)));
    }
    if (reachable.length === 0) {
      // 地表没有够得到的源方块 → 地面材料(dirt/stone/sand…)改竖直下挖脚下块兜底。
      //   关键：surface 优先、dig-down 兜底——山地有大量裸露石头时直接表挖，
      //   不再无脑下挖自陷坑、再被 EscapeStrategy 垫脚消耗掉刚挖的圆石(死循环根因)。
      if (isGroundMaterial(blockName)) {
        const digDown = this.tryDigDown(ctx, blockName, toolName);
        if (digDown) {
          this.missStreak = 0;
          this.lastPhase = 'digdown';
          return [digDown];
        }
      }
      this.missStreak++;
      // 连续 N 次没找到 → 不原地打转：移动到新区域再找（树/矿在别处）。
      if (this.missStreak >= EXPLORE_AFTER_MISS) {
        if (this.exploreAttempts >= MAX_EXPLORE) {
          this.finishFail(t.id, { code: 'no_resource_found', detail: `找了一圈也没找到${material}` });
          ctx.narrate?.({ source: 'gather', topic: 'gather_no_resource', urgency: 45, data: { material: zhMaterial(material) } });
          return [];
        }
        this.exploreAttempts++;
        this.missStreak = 0;
        this.lastProgressTick = ctx.tick; // 探索算活动，别让 stall 看门狗误杀
        this.lastPhase = 'exploring';
        const wp = explorationWaypoint(ctx.world.self.position, this.exploreAttempts);
        this.bus.publish('gather.explore', 'info', { material, attempt: this.exploreAttempts, to: wp });
        // 用 walk 原子直接朝该方向走一段（不寻路，可靠位移），走完再 findBlocks
        const out: ActionRequest[] = [{
          id: `${this.id}-explore-${ctx.tick}-${++this.seq}`,
          source: this.id,
          type: 'walk',
          priority: 30,
          interrupt_level: 'soft',
          resource: ['movement'],
          target: { position: wp, durationMs: 5800 },
          preconditions: [],
          expected_effect: ['relocated'],
          timeout_ms: 8000,
        }];
        const say = this.maybeExploreSay(ctx, material);
        if (say) out.push(say);
        return out;
      }
      this.lastPhase = 'searching';
      return [];
    }
    this.missStreak = 0;
    this.lastPhase = 'mining';
    const target = reachable[0];
    const tkey = keyOf(target);

    // ★ 假成功不可达检测：move_to 对"GoalNear 判定已近但实际够不到"的块会秒成功不动
    //   （真服实证：bot 在山顶对岸边树反复 gather_block exec OK 却原地冻住、永不探索）。
    //   连续盯同一目标却"没移动也没采到" → 拉黑它、试别的；全黑→reachable=0→走探索(可挖穿).
    const selfPos = ctx.world.self.position;
    if (tkey === this.lastTargetKey) {
      const movedToward = this.lastTargetBotPos
        ? Math.hypot(selfPos.x - this.lastTargetBotPos.x, selfPos.z - this.lastTargetBotPos.z) : 99;
      const gotItem = have > this.lastHaveAtTarget;
      if (movedToward < 0.6 && !gotItem) {
        this.targetNoProgress++;
        if (this.targetNoProgress >= 2) {
          this.unreachable.set(tkey, Date.now() + 60000); // 拉黑 60s
          this.targetNoProgress = 0;
          this.lastTargetKey = '';
          this.bus.publish('gather.unreachable', 'info', { material, blacklisted: tkey, reason: 'false_success_no_move' });
          return []; // 下一 tick 重新 findBlocks（已拉黑此块，换目标/转探索）
        }
      } else {
        this.targetNoProgress = 0;
      }
    } else {
      this.targetNoProgress = 0;
    }
    this.lastTargetKey = tkey;
    this.lastTargetBotPos = { x: selfPos.x, y: selfPos.y, z: selfPos.z };
    this.lastHaveAtTarget = have;

    // 4a) 矿石（嵌在石头里，pathfinder 走不到）→ 用 mine_to 挖隧道凿过去（支线挖矿）。
    //     真服实证：iron_ore 找得到却反复 nav_timeout；普通 gather_block 的 move_to 够不到。
    if (isOreBlock(blockName)) {
      return [{
        id: `${this.id}-mineto-${ctx.tick}-${++this.seq}`,
        source: this.id,
        type: 'mine_to',
        priority: 30,
        interrupt_level: 'soft',
        resource: ['movement', 'inventory'],
        target: { position: target, itemName: toolName },
        preconditions: [],
        expected_effect: ['gathered_material'],
        timeout_ms: 30000,
      }];
    }

    // 4b) 普通方块：发起一次采集周期（move_to+dig+pickup）
    return [{
      id: `${this.id}-gather-${ctx.tick}-${++this.seq}`,
      source: this.id,
      type: 'invoke_behavior',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement', 'inventory'],
      target: {
        behavior: 'gather_block',
        behaviorParams: {
          pos: target,
          toolName,
          blockName,
          acceptedItems: logMode ? ALL_LOGS : [material],
        },
      },
      preconditions: [],
      expected_effect: ['gathered_material'],
      timeout_ms: 30000,
    }];
  }

  /**
   * 扫描附近"可拾取的掉落物"实体。
   * 仅认 name==='item'（避免锁定画/盔甲架/物品展示框等其他 object 实体导致死循环）；
   * 且只拾取 1.2~range 格的——更近的会被 mineflayer 自动拾取，不必专门走过去。
   */
  private findNearbyDrop(selfPos: Vec3): Vec3 | null {
    const ents = this.game.getEntities();
    let best: Vec3 | null = null;
    let bestD = DROP_PICKUP_RANGE * DROP_PICKUP_RANGE;
    const minD2 = 1.2 * 1.2;
    for (const e of ents) {
      if (e.name !== 'item') continue;
      const dx = e.position.x - selfPos.x;
      const dy = e.position.y - selfPos.y;
      const dz = e.position.z - selfPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minD2) continue;          // 很近的交给自动拾取
      if (d2 <= bestD) { bestD = d2; best = e.position; }
    }
    return best;
  }

  private moveTo(ctx: StrategyContext, pos: Vec3, tag: string): ActionRequest {
    return {
      id: `${this.id}-${tag}-${ctx.tick}-${++this.seq}`,
      source: this.id,
      type: 'move_to',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement'],
      target: { position: pos },
      preconditions: [],
      timeout_ms: 10000,
    };
  }

  private maybeExploreSay(ctx: StrategyContext, material: string): ActionRequest | null {
    const now = Date.now();
    if (now - this.lastExploreSayAt < 6000) return null;
    this.lastExploreSayAt = now;
    return null; // FEAT-NARR-01: 探索过程播报(🟡)已砍
  }

  /**
   * 竖直下挖脚下的地面块（dirt/stone/sand…埋在地下 move_to 够不到时用）。
   * 安全：再下一格必须实心非岩浆（最多掉 1 格，不会掉进洞/岩浆）。
   * 返回 null 表示脚下不是可挖的目标地面块 / 不安全 → 回退到 findBlocks。
   */
  private tryDigDown(ctx: StrategyContext, blockName: string, toolName: string | undefined): ActionRequest | null {
    const p = ctx.world.self.position;
    const fx = Math.floor(p.x), fz = Math.floor(p.z);
    // 深度上限：记录起始地表 Y，挖到 MAX_DIGDOWN 格深就停（别把自己埋死）。
    // 到上限后返回 null → 上层走 findBlocks/探索；若困住，EscapeStrategy 会垫脚爬出。
    const curY = Math.floor(p.y);
    // 回到/高于起始地表（如 EscapeStrategy 垫脚爬出后）→ 重置基准，开新一轮下挖
    if (this.digDownBaseY == null || curY >= this.digDownBaseY) this.digDownBaseY = curY;
    if (this.digDownBaseY - curY >= MAX_DIGDOWN) return null;
    for (const fy of [Math.floor(p.y) - 1, Math.floor(p.y)]) {
      const pos = { x: fx, y: fy, z: fz };
      const blk = this.game.getBlockAt(pos);
      if (!blk) continue;
      if (!diggableGround(blk.name, blockName)) continue;
      // 安全检查：脚下块本身 + 再下一格都不能是岩浆；再下一格必须实心（防掉空）
      if (/lava/i.test(blk.name)) return null;
      const below = this.game.getBlockAt({ x: fx, y: fy - 1, z: fz });
      if (!below || below.boundingBox !== 'block' || /lava/i.test(below.name)) return null;
      this.lastTargetKey = keyOf(pos);
      return {
        id: `${this.id}-digdown-${ctx.tick}-${++this.seq}`,
        source: this.id,
        type: 'invoke_behavior',
        priority: 30,
        interrupt_level: 'soft',
        resource: ['movement', 'inventory'],
        target: {
          behavior: 'gather_block',
          behaviorParams: { pos, toolName, blockName, acceptedItems: [blockName] },
        },
        preconditions: [],
        expected_effect: ['gathered_material'],
        timeout_ms: 20000,
      };
    }
    return null;
  }

  /** 清理已解禁的不可达黑名单条目 */
  private cleanUnreachable(): void {
    const now = Date.now();
    for (const [k, until] of this.unreachable) {
      if (now >= until) this.unreachable.delete(k);
    }
  }

  private finishFail(taskId: string, reason: FailureReason): void {
    this.lastPhase = 'failed';
    this.tasks.fail(taskId, reason);
  }

  reset(): void {
    this.seq = 0;
    this.missStreak = 0;
    this.sinceTick = 0;
    this.lastPhase = 'idle';
    this.lastHave = -1;
    this.lastProgressTick = 0;
    this.pickupNoGain = 0;
    this.lastTaskId = '';
    this.unreachable.clear();
    this.lastTargetKey = '';
    this.exploreAttempts = 0;
    this.lastExploreSayAt = 0;
    this.digDownBaseY = null;
    this.lastTargetBotPos = null;
    this.lastHaveAtTarget = -1;
    this.targetNoProgress = 0;
  }

  inspect(): StrategyInspect {
    return { kind: 'fsm', view: { phase: this.lastPhase, missStreak: this.missStreak }, sinceTick: this.sinceTick };
  }
}

// ───────── helpers ─────────

/** 在库存里找"同类别且档位≥要求"的工具，优先最高档（更快/更耐用） */
/** 方块坐标键（取整，用于不可达黑名单） */
function keyOf(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

/**
 * BUG-CROSS-31：黑名单描述的是旧位置的导航失败，不是方块永久不可用。
 * 机器人已经移动到直接交互距离后，允许重新尝试；远处候选仍等待黑名单过期。
 */
export function isGatherCandidateEligible(
  candidate: { x: number; y: number; z: number },
  self: { x: number; y: number; z: number },
  unreachable: ReadonlyMap<string, number>,
): boolean {
  if (!unreachable.has(keyOf(candidate))) return true;
  return Math.hypot(candidate.x - self.x, candidate.y - self.y, candidate.z - self.z) <= DIRECT_INTERACTION_RANGE;
}

/** 水平面距离（忽略 Y，用于"砍最近的树基" 排序） */
function distXZ(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 探索航点：按尝试次数轮换 8 个方向，距离 EXPLORE_DIST，保持同 Y（地表找树/矿） */
const EXPLORE_COMMIT = 3; // 同一方向连走 N 次（约 3×40=120 格）再换向 → 决然逃离本地、不原地打转
function explorationWaypoint(pos: { x: number; y: number; z: number }, attempt: number): { x: number; y: number; z: number } {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  // 每 EXPLORE_COMMIT 次才换方向：朝一个方向走够远(冲出资源贫瘠的本地圈)再试别的方向，
  //   避免每次换向在山顶 ~5 格小圈里来回（真服实证：bot 解冻后原地兜圈到不了树）。
  const d = dirs[Math.floor((attempt - 1) / EXPLORE_COMMIT) % dirs.length];
  const len = Math.sqrt(d[0] * d[0] + d[1] * d[1]) || 1;
  return {
    x: Math.floor(pos.x + (d[0] / len) * EXPLORE_DIST),
    y: pos.y,
    z: Math.floor(pos.z + (d[1] / len) * EXPLORE_DIST),
  };
}

/** 典型"埋在地下/地表"的地面块——这类材料用竖直下挖更可靠（move_to 走不到埋块旁边） */
const GROUND_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud',
  'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'calcite',
  'sand', 'red_sand', 'gravel', 'clay', 'sandstone', 'red_sandstone',
  'netherrack', 'soul_sand', 'soul_soil', 'snow_block', 'moss_block',
]);
function isGroundMaterial(blockName: string): boolean {
  return GROUND_BLOCKS.has(blockName);
}
/** 脚下块 blockHere 挖了能不能算"采到 material 的源块" */
function diggableGround(blockHere: string, material: string): boolean {
  if (blockHere === material) return true;
  // 草方块/各种泥土挖了掉 dirt
  if (material === 'dirt' && /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium)$/.test(blockHere)) return true;
  // 同为地面块的宽松匹配（源块统一后大多已 === 命中，这里兜底）
  return GROUND_BLOCKS.has(blockHere) && GROUND_BLOCKS.has(material);
}

function findToolInInv(names: string[], requiredTool: string): string | undefined {
  const cat = toolCategory(requiredTool);
  if (!cat) return undefined;
  const reqRank = toolTierRank(requiredTool);
  const qualifying = names
    .filter(n => toolCategory(n) === cat && toolTierRank(n) >= reqRank)
    .sort((a, b) => toolTierRank(b) - toolTierRank(a));
  return qualifying[0];
}

function zhMaterial(name: string): string {
  const map: Record<string, string> = {
    oak_log: '橡木', spruce_log: '云杉木', birch_log: '白桦木', jungle_log: '丛林木',
    acacia_log: '金合欢木', dark_oak_log: '深色橡木', cobblestone: '圆石', stone: '石头',
    dirt: '泥土', sand: '沙子', coal: '煤炭', oak_planks: '橡木木板',
  };
  return map[name] ?? name;
}
function zhTool(name: string): string {
  const map: Record<string, string> = {
    wooden_pickaxe: '木镐', stone_pickaxe: '石镐', iron_pickaxe: '铁镐',
    wooden_axe: '木斧', wooden_shovel: '木铲',
  };
  return map[name] ?? name;
}
