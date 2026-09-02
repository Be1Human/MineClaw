/**
 * L3 · Atomic 原子行为（v2 · 最小集）
 *
 * 每个 atomic 强制 5 步骨架：
 *   ① 类型校验
 *   ② 前置白名单
 *   ③ 固定参数
 *   ④ 失败熔断
 *   ⑤ 显式事件
 *
 * 输入：ActionRequest + 适配器
 * 输出：Promise<ExecutionResult>（成功/失败）
 */

import type { GameActions } from '../../adapter/GameActions.js';
import type { NavigationActions } from '../../adapter/NavigationExecution.js';
import type { ControlledExecutionContext } from '../task/execution/ports/controlledExecution.js';
import type { GameView } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { ActionRequest, ExecutionResult, WorldStateView, InventoryView } from '../types.js';
import { findPitExit, isTrappedInPit } from '../navigation/pitGeometry.js';
import { tuning } from '../infra/tuning.js';
import { RecipeResolver, pickFuel } from '../knowledge/recipeResolver.js';
import { ATOM_VERIFIERS, resolvePlacement, type AtomVerifier, type VerifyVerdict } from './verifiers.js';

export interface AtomicContext {
  game: GameView;
  actions: GameActions;
  nav: NavigationActions;
  bus: EventBusV2;
  execution: ControlledExecutionContext;
  getWorld(): WorldStateView;
}

/**
 * 入口：执行一个原子 = 动作前快照 → 派发 handler → 动作后验真（物理效果回查）。
 * 验真分层/三态/observe-enforce 见 verifiers.ts；修的是"调用没报错就算成功"的框架旧 bug。
 */
export async function executeAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
): Promise<ExecutionResult> {
  ctx.execution.assertCurrent('atomic_start');
  const start = Date.now();
  const cfg = tuning().atomic;
  const verifier = cfg.verifyEnabled ? ATOM_VERIFIERS[req.type] : undefined;
  const mode = verifier ? (cfg.verifyMode[req.type] ?? 'off') : 'off';
  // ① 动作前快照（只在要验真时拍）
  const before = mode !== 'off' ? verifier!.snapshot?.(req, ctx.game) : undefined;
  // ② 派发执行
  const result = await dispatch(req, ctx, start);
  ctx.execution.assertCurrent('atomic_result');
  // ③ 动作后验真（仅对成功的动作 · fail 的本就失败无需验）
  if (result.ok && mode !== 'off' && verifier) {
    const v = await runVerify(verifier, req, ctx, before);
    if (v.status === 'fail') {
      ctx.bus.publish('atomic.unverified', mode === 'enforce' ? 'recoverable' : 'info', {
        type: req.type, mode, reason: v.reason, source: req.source,
      });
      if (mode === 'enforce') {
        return fail(req, start, `${req.type}_unverified: ${v.reason ?? 'effect not observed'}`);
      }
      // observe：只告警，保留原 success
    }
  }
  return result;
}

/** fail 时短轮询兜底（给服务器同步留时间）；pass/unknown 立即返回（unknown 不阻断） */
async function runVerify(
  verifier: AtomVerifier,
  req: ActionRequest,
  ctx: AtomicContext,
  before: unknown,
): Promise<VerifyVerdict> {
  const cfg = tuning().atomic;
  let v = verifier.verify(req, ctx.game, before);
  if (v.status !== 'fail') return v;
  const deadline = Date.now() + cfg.verifyTimeoutMs;
  while (Date.now() < deadline) {
    await ctx.execution.wait(cfg.verifyPollMs);
    v = verifier.verify(req, ctx.game, before);
    if (v.status !== 'fail') return v;
  }
  return v;
}

/** 派发：根据 ActionRequest.type 调具体 atomic（原 executeAtomic 主体） */
async function dispatch(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  try {
    switch (req.type) {
      case 'move_to':
      case 'goto_position':
        return await moveTo(req, ctx, start);
      case 'follow_entity':
        return followEntity(req, ctx, start);
      case 'attack':
        return await attackOnce(req, ctx, start);
      case 'say':
        return say(req, ctx, start);
      case 'use_tool':
        return await useTool(req, ctx, start);
      case 'equip':
        return await equipItem(req, ctx, start);
      case 'place_block':
        return await placeBlock(req, ctx, start);
      case 'dig':
        return await digBlock(req, ctx, start);
      case 'craft':
        return await craftItem(req, ctx, start);
      case 'smelt':
        return await smeltItem(req, ctx, start);
      case 'walk':
        return await walkToward(req, ctx, start);
      case 'escape_pit':
        return await escapePit(req, ctx, start);
      case 'mine_to':
        return await mineTo(req, ctx, start);
      case 'look_at':
        return await lookAt(req, ctx, start);
      case 'toss_item':
        return await tossItem(req, ctx, start);
      case 'eat':
        return await eat(req, ctx, start);
      case 'sleep':
        return await sleepAtomic(req, ctx, start);
      case 'wake':
        return await wakeAtomic(req, ctx, start);
      case 'deposit':
        return await deposit(req, ctx, start);
      case 'withdraw':
        return await withdraw(req, ctx, start);
      case 'equip_best_armor':
        return await equipBestArmor(req, ctx, start);
      case 'fish':
        return await fishAtomic(req, ctx, start);
      case 'climb_up':
        return await climbUpAtomic(req, ctx, start);
      case 'pillar_up':
        return await pillarUpAtomic(req, ctx, start);
      case 'dig_down':
        return await digDownAtomic(req, ctx, start);
      case 'place_scaffold':
        return await placeScaffoldAtomic(req, ctx, start);
      case 'mount':
        return await mountAtomic(req, ctx, start);
      case 'dismount':
        return await dismountAtomic(req, ctx, start);
      case 'vehicle_goto':
        return await moveTo(req, ctx, start); // FEAT-L3-09 · alias to moveTo（已挂载时由 pathfinder 驱动载具）
      case 'kite':
        return await kiteAtomic(req, ctx, start);
      case 'block_with_shield':
        return await blockWithShieldAtomic(req, ctx, start);
      case 'bow_shoot':
        return await bowShootAtomic(req, ctx, start);
      case 'crit_jump_attack':
        return await critJumpAttackAtomic(req, ctx, start);
      default:
        return fail(req, start, `unsupported atomic type: ${req.type}`);
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    ctx.bus.publish('atomic.error', 'recoverable', { type: req.type, error: err });
    return fail(req, start, err);
  }
}

// ───────────────────────── move_to / follow_entity ─────────────────────────

async function moveTo(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // entityId 模式：朝移动中的实体接近（combat 接敌 / 拾取掉落物等）。
  // 实体会动，用 nav 的 entity 目标（GoalNear 实体当前位置，range=2 适合近战）。
  if (!req.target?.position && req.target?.entityId != null) {
    const eid = req.target.entityId;
    const budgetE = req.timeout_ms && req.timeout_ms > 0 ? req.timeout_ms : 8000;
    ctx.bus.publish('atomic.move_to.start', 'info', { entityId: eid });
    const rr = await ctx.nav.goto({ type: 'entity', entityId: eid, range: 2 }, { thinkTimeout: 3000, totalTimeout: budgetE });
    ctx.bus.publish('atomic.move_to.end', 'info', { ok: rr.ok, reason: rr.reason, entityId: eid });
    return { ok: rr.ok, request: req, durationMs: Date.now() - start, error: rr.ok ? undefined : (rr.reason || 'nav_failed') };
  }
  if (!req.target?.position) return fail(req, start, 'move_to requires target.position or entityId');
  const originalTarget = req.target.position;
  const pos = resolveNavigationTarget(originalTarget, ctx.game, req.source === 'gather_block');
  ctx.bus.publish('atomic.move_to.start', 'info', {
    target: pos,
    originalTarget,
    normalized: pos.x !== originalTarget.x || pos.y !== originalTarget.y || pos.z !== originalTarget.z,
  });

  // BUG-L3-02 修复：
  // 1) 严格遵守请求 timeout_ms（作为 nav totalTimeout 上限）→ 逃跑不再 30-49s 霸占执行锁。
  // 2) 短中距离一律 pathfinder 直连（快·可靠）·占绝大多数（采集 32-64m / 逃跑 20m / 跟随）。
  // 3) 仅真·超远(>120 格)且有 navRouter 时才用融合导航。
  // 4) 删除"navRouter 失败再 fallback nav.goto"的双重导航（最坏 60s 的元凶）。
  const budget = req.timeout_ms && req.timeout_ms > 0 ? req.timeout_ms : 15000;
  const requestedRange = req.target.range;
  const range = typeof requestedRange === 'number' && Number.isFinite(requestedRange)
    && requestedRange >= 0 && requestedRange <= 8
    ? requestedRange
    : 1;
  // 短中距：pathfinder 直连，硬上限 = budget
  const result = await ctx.nav.goto(
      { type: 'block', position: pos, range },
      { thinkTimeout: 5000, totalTimeout: budget },
    );

  ctx.bus.publish('atomic.move_to.end', 'info', { ok: result.ok, reason: result.reason });
  return {
    ok: result.ok,
    request: req,
    durationMs: Date.now() - start,
    error: result.ok ? undefined : result.reason || 'nav_failed',
  };
}

/**
 * BUG-L5-01 · 跟随主人 —— 幂等非阻塞动态目标。
 *
 * 旧实现把 GoalFollow（pathfinder 动态常驻目标）当一次性 `goto().await + 30s 超时` 调，
 * 导致跟随阻塞 30s、声明 5s 失配、上层被迫加 stuck-detector 兜底（还死锁）。
 *
 * 新实现：调 nav.startFollow 设一次 dynamic GoalFollow，pathfinder 后台持续驱动
 * （进 range 自停、owner 动自追、永不 timeout），**立即返回**，不占执行锁。
 * FollowStrategy 每 tick 重新提交本 atomic 即幂等维持跟随；离开跟随态发 stop_follow。
 */
/** Interactable blocks are not standable destinations. */
function resolveNavigationTarget(target: Vec3, game: GameView, allowLowerApproach = false): Vec3 {
  const getBlockAt = (game as Partial<GameView>).getBlockAt;
  if (typeof getBlockAt !== 'function') return target;
  const block = getBlockAt.call(game, target);
  if ((!block || block.boundingBox !== 'block') && !allowLowerApproach) return target;
  const verticalOffsets = allowLowerApproach ? [0, -1, -2, -3] : [0];
  for (const dy of verticalOffsets) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const position = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
      const foot = getBlockAt.call(game, position);
      const head = getBlockAt.call(game, { ...position, y: position.y + 1 });
      const ground = getBlockAt.call(game, { ...position, y: position.y - 1 });
      if (foot?.boundingBox === 'empty' && head?.boundingBox === 'empty' && ground?.boundingBox === 'block') {
        return position;
      }
    }
  }
  return target;
}

async function followEntity(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const id = req.target?.entityId;
  if (id == null) return fail(req, start, 'follow_entity requires target.entityId');
  const range = tuning().follow.followRange;
  ctx.bus.publish('atomic.follow.start', 'info', { entityId: id });
  const result = await ctx.nav.follow(id, range);
  return { ok: result.ok, request: req, durationMs: Date.now() - start, error: result.reason };
}

// ───────────────────────── attack ─────────────────────────

async function attackOnce(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const id = req.target?.entityId;
  if (id == null) return fail(req, start, 'attack requires target.entityId');
  const ent = ctx.game.getEntityById(id);
  if (!ent) return fail(req, start, 'attack target not found');

  // 先 lookAt，再 attack（最简单可靠）
  await ctx.actions.lookAt(ent.position, true);
  await ctx.actions.attack(id);
  ctx.bus.publish('atomic.attack', 'info', { entityId: id, target: ent.name });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── say ─────────────────────────

function say(req: ActionRequest, ctx: AtomicContext, start: number): ExecutionResult {
  const raw = req.target?.text;
  if (!raw) return fail(req, start, 'say requires target.text');
  const text = String(raw).trim();
  if (!text) return fail(req, start, 'say text empty');
  ctx.bus.publish('brain.notice', 'suggestion', {
    source: req.source,
    topic: 'atomic_speech_request',
    label: '原子执行层请求发言',
    detail: text,
    status: 'info',
    wake: req.priority >= 60,
    dedupeKey: `atomic_say:${req.source}:${text}`,
  });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── eat / sleep / wake（FEAT-L3-02） ─────────────────────────

async function eat(req: ActionRequest, ctx: AtomicContext, start: number): Promise<ExecutionResult> {
  // 食物：优先用指定的，否则自动挑背包里最值得吃的
  const itemName = req.target?.itemName ?? ctx.game.findBestFood();
  if (!itemName) return fail(req, start, 'eat: no food in inventory');
  ctx.bus.publish('atomic.eat.start', 'info', { source: req.source, item: itemName });
  try {
    await ctx.actions.equip(itemName, 'hand');
    const ok = await ctx.actions.consume();
    if (!ok) {
      ctx.bus.publish('atomic.eat.fail', 'recoverable', { source: req.source, item: itemName });
      return fail(req, start, 'eat_failed');
    }
  } catch (e) {
    return fail(req, start, `eat_failed:${(e as Error).message}`);
  }
  ctx.bus.publish('atomic.eat.success', 'info', { source: req.source, item: itemName, food: ctx.game.getFood() });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * sleep · 睡觉（FEAT-L3-04）。
 *
 * 真服实证：bot.sleep 在以下情况会抛错，原 atomic 抛错信息含糊，不利上层兜底。
 *   ① 白天 → 'not_possible_now'
 *   ② 怪物在床周围 8 格 → 'there_are_monsters_nearby'
 *   ③ 床被占 / 不可达 → 'too_far_away' / 'others_sleeping'
 *
 * 本 atomic 在调 bot.sleep 之前做 3 项预检，让上层（L5 夜晚策略）拿到
 * 结构化失败原因来决定回退（搭掩体 / 逃跑 / 等等再试）。
 *
 * 顺便：mineflayer 的 bot.sleep 在 wakeup 成功时**会自动 setSpawnPoint**
 * （走的是 vanilla 服务端逻辑），所以重生点不需要我们手动设。
 */
async function sleepAtomic(req: ActionRequest, ctx: AtomicContext, start: number): Promise<ExecutionResult> {
  // 床位置：优先用给定的，否则就近找床（覆盖所有 *_bed）
  const pos = req.target?.position ?? ctx.game.findNearbyBed(16) ?? undefined;
  if (!pos) {
    ctx.bus.publish('atomic.sleep.fail', 'recoverable', { source: req.source, reason: 'no_bed_nearby' });
    return fail(req, start, 'sleep_failed:no_bed_nearby');
  }

  // ── 预检①：怪物在床附近（半径 8 格）→ 直接失败，避免被 mineflayer 抛错坑住
  const monsterInfo = checkHostileNear(ctx, pos, 8);
  if (monsterInfo) {
    ctx.bus.publish('atomic.sleep.fail', 'recoverable', {
      source: req.source,
      reason: 'monster_nearby',
      monster: monsterInfo.name,
      monsterPos: monsterInfo.pos,
    });
    return fail(req, start, `sleep_failed:monster_nearby:${monsterInfo.name}`);
  }

  // ── 预检②：白天且非雷暴 → 睡不了（vanilla 规则）
  if (!canSleepNow(ctx)) {
    ctx.bus.publish('atomic.sleep.fail', 'recoverable', {
      source: req.source,
      reason: 'not_night',
      timeOfDay: ctx.game.getTimeOfDay(),
    });
    return fail(req, start, 'sleep_failed:not_night');
  }

  ctx.bus.publish('atomic.sleep.start', 'info', { source: req.source, pos });
  try {
    await ctx.actions.sleep(pos);
  } catch (e) {
    const err = (e as Error).message;
    // 把 mineflayer 的常见错误映射成稳定 reason，便于上层 switch
    const reason = mapSleepError(err);
    ctx.bus.publish('atomic.sleep.fail', 'recoverable', { source: req.source, error: err, reason });
    return fail(req, start, `sleep_failed:${reason}`);
  }
  ctx.bus.publish('atomic.sleep.success', 'info', { source: req.source, pos });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/** 与 perception/pipeline.ts 的 hostile 分类同源 */
const HOSTILE_MOB_NAMES = [
  'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman',
  'husk', 'drowned', 'pillager', 'vindicator', 'phantom', 'slime',
];

function isHostile(name: string): boolean {
  return HOSTILE_MOB_NAMES.some(h => name.includes(h));
}

/** 检查床周围是否有敌对生物（mineflayer 服务端逻辑：床 ±8 格内有怪就睡不了）。 */
function checkHostileNear(
  ctx: AtomicContext,
  pos: Vec3,
  radius: number,
): { name: string; pos: Vec3 } | null {
  const entities = ctx.game.getEntities();
  for (const e of entities) {
    if (!e || !e.name) continue;
    if (!isHostile(e.name)) continue;
    const dx = e.position.x - pos.x;
    const dy = e.position.y - pos.y;
    const dz = e.position.z - pos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d <= radius) return { name: e.name, pos: e.position };
  }
  return null;
}

/** vanilla：12541 ≤ timeOfDay ≤ 23458 才能睡（夜晚），或下雷暴时白天也能睡。 */
function canSleepNow(ctx: AtomicContext): boolean {
  const t = ctx.game.getTimeOfDay() % 24000;
  const isNight = t >= 12541 && t <= 23458;
  return isNight || ctx.game.isThundering();
}

// ───────────────────────── equip_best_armor（FEAT-L3-07） ─────────────────────────

/** 盔甲材质 → armor points（vanilla 1.20）· 同槽位选最大的 */
const ARMOR_POINTS: Record<string, number> = {
  leather: 1,
  golden: 2,
  chainmail: 2,
  iron: 3,
  diamond: 3,
  netherite: 3,
  turtle: 2, // turtle_helmet
};

/** 头/胸/腿/脚 4 槽位的物品名后缀（不含材质前缀） */
const ARMOR_SLOTS: Array<{ dest: 'head' | 'torso' | 'legs' | 'feet'; suffix: string }> = [
  { dest: 'head', suffix: '_helmet' },
  { dest: 'torso', suffix: '_chestplate' },
  { dest: 'legs', suffix: '_leggings' },
  { dest: 'feet', suffix: '_boots' },
];

/** 把物品名（如 "iron_helmet" / "turtle_helmet"）拆出材质前缀 */
function getArmorTier(name: string, suffix: string): number {
  if (!name.endsWith(suffix)) return -1;
  const prefix = name.slice(0, -suffix.length);
  return ARMOR_POINTS[prefix] ?? -1;
}

/**
 * equip_best_armor · 遍历背包，按 armorPoints 给每个槽位选最优盔甲并装备。
 *
 * 设计：
 *   - 纯能力函数，无状态。可由 L5 'damage_taken' / 'spawn' / 'idle' 等触发。
 *   - 已穿同档或更高 → 跳过（不会反复换装造成卡顿/RPC 风暴）。
 *   - 任何单槽 equip 失败不影响其它槽位（独立 try/catch）。
 *
 * 注：mineflayer-armor-manager 是第三方插件，引入一个 4 行的核心策略不值得加依赖。
 */
async function equipBestArmor(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  ctx.bus.publish('atomic.equip_best_armor.start', 'info', { source: req.source });
  const inv = ctx.game.getInventoryItems();
  // 已穿盔甲 = "slot in 5-8" 的物品（mineflayer：头5/胸6/腿7/脚8）
  const worn = new Map<string, RawItemLite>(); // dest -> item
  for (const it of inv) {
    if (it.slot === 5) worn.set('head', it);
    else if (it.slot === 6) worn.set('torso', it);
    else if (it.slot === 7) worn.set('legs', it);
    else if (it.slot === 8) worn.set('feet', it);
  }

  let equipped = 0;
  const details: Array<{ dest: string; item: string; tier: number }> = [];

  for (const slot of ARMOR_SLOTS) {
    // 从背包中找该 suffix 下最佳 tier
    let best: { name: string; tier: number } | null = null;
    for (const it of inv) {
      const tier = getArmorTier(it.name, slot.suffix);
      if (tier < 0) continue;
      if (!best || tier > best.tier) best = { name: it.name, tier };
    }
    if (!best) continue;

    // 已穿同名 / 已穿更高 tier → 跳过
    const wornIt = worn.get(slot.dest);
    if (wornIt) {
      const wornTier = getArmorTier(wornIt.name, slot.suffix);
      if (wornIt.name === best.name) continue;
      if (wornTier >= best.tier) continue;
    }

    try {
      await ctx.actions.equip(best.name, slot.dest);
      equipped++;
      details.push({ dest: slot.dest, item: best.name, tier: best.tier });
    } catch (e) {
      ctx.bus.publish('atomic.equip_best_armor.slot_fail', 'recoverable', {
        source: req.source,
        dest: slot.dest,
        item: best.name,
        error: (e as Error).message,
      });
      // 其它槽位继续
    }
  }

  ctx.bus.publish('atomic.equip_best_armor.success', 'info', {
    source: req.source,
    equipped,
    details,
  });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/** equip_best_armor 内部用的简化 RawItem 视图 */
type RawItemLite = { name: string; slot: number };

function mapSleepError(err: string): string {
  const e = err.toLowerCase();
  if (e.includes('monster')) return 'monster_nearby';
  if (e.includes('not_possible') || e.includes('day')) return 'not_night';
  if (e.includes('too_far') || e.includes('far away')) return 'too_far_away';
  if (e.includes('occupied') || e.includes('others')) return 'bed_occupied';
  if (e.includes('no_bed') || e.includes('not_safe')) return 'no_bed_block';
  return err; // 透传原始错
}

async function wakeAtomic(req: ActionRequest, ctx: AtomicContext, start: number): Promise<ExecutionResult> {
  await ctx.actions.wake();
  ctx.bus.publish('atomic.wake', 'info', { source: req.source });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── deposit / withdraw（FEAT-L3-03） ─────────────────────────
// 注意：箱子交互要求 bot 已在交互距离内（≤约4格）· 上层 Skill 应先 move_to 箱子再调用本 atomic

async function deposit(req: ActionRequest, ctx: AtomicContext, start: number): Promise<ExecutionResult> {
  const pos = req.target?.position;
  const itemName = req.target?.itemName;
  if (!pos) return fail(req, start, 'deposit requires target.position (chest pos)');
  if (!itemName) return fail(req, start, 'deposit requires target.itemName');
  const count = req.target?.count ?? 64;
  ctx.bus.publish('atomic.deposit.start', 'info', { source: req.source, item: itemName, count, pos });
  const r = await ctx.actions.depositToChest(pos, itemName, count);
  if (!r.ok) {
    ctx.bus.publish('atomic.deposit.fail', 'recoverable', { source: req.source, item: itemName, error: r.reason });
    return fail(req, start, `deposit_failed:${r.reason}`);
  }
  // FEAT-MEM-06 · payload 透传 contents（chest 关闭前抓的内容），供 WorldScan 写索引
  ctx.bus.publish('atomic.deposit.success', 'info', {
    source: req.source, item: itemName, moved: r.moved, pos, contents: r.contents,
  });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

async function withdraw(req: ActionRequest, ctx: AtomicContext, start: number): Promise<ExecutionResult> {
  const pos = req.target?.position;
  const itemName = req.target?.itemName;
  if (!pos) return fail(req, start, 'withdraw requires target.position (chest pos)');
  if (!itemName) return fail(req, start, 'withdraw requires target.itemName');
  const count = req.target?.count ?? 64;
  ctx.bus.publish('atomic.withdraw.start', 'info', { source: req.source, item: itemName, count, pos });
  const r = await ctx.actions.withdrawFromChest(pos, itemName, count);
  if (!r.ok) {
    ctx.bus.publish('atomic.withdraw.fail', 'recoverable', { source: req.source, item: itemName, error: r.reason });
    return fail(req, start, `withdraw_failed:${r.reason}`);
  }
  // FEAT-MEM-06 · payload 透传 contents（chest 关闭前抓的内容），供 WorldScan 写索引
  ctx.bus.publish('atomic.withdraw.success', 'info', {
    source: req.source, item: itemName, moved: r.moved, pos, contents: r.contents,
  });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── use_tool / equip ─────────────────────────

async function useTool(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const itemName = req.target?.itemName;
  if (!itemName) return fail(req, start, 'use_tool requires target.itemName');
  // 1. 装备到手
  const held = ctx.game.getHeldItem();
  if (held?.name !== itemName) {
    try {
      await ctx.actions.equip(itemName, 'hand');
    } catch (e) {
      return fail(req, start, `equip_failed:${(e as Error).message}`);
    }
  }
  // 2. 看向目标块（如有）
  if (req.target?.position) {
    await ctx.actions.lookAt(req.target.position, true);
  }
  // 3. 激活物品（右键使用）
  await ctx.actions.activateItem();
  // 给 mineflayer 一点反应时间
  await ctx.execution.wait(150);
  await ctx.actions.deactivateItem();

  ctx.bus.publish('atomic.use_tool.success', 'info', {
    source: req.source,
    item: itemName,
  });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

async function equipItem(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const itemName = req.target?.itemName;
  if (!itemName) return fail(req, start, 'equip requires target.itemName');
  try {
    await ctx.actions.equip(itemName, 'hand');
    // BUG-CROSS-80 · equip 后主动等待服务器同步手持（约 1.5s），失败即结构化失败，
    // 不再把"手持未变"留给后置验真消耗恢复预算。
    const observeStarted=Date.now();
    while (Date.now()-observeStarted < tuning().deviceActions.equipObserveTimeoutMs) {
      if (ctx.game.getHeldItem()?.name === itemName) break;
      await ctx.execution.wait(tuning().deviceActions.equipObservePollMs);
    }
    if (ctx.game.getHeldItem()?.name !== itemName) {
      return fail(req, start, `equip_unverified: 手持为 ${ctx.game.getHeldItem()?.name ?? '空'}，期望 ${itemName}`);
    }
    ctx.bus.publish('atomic.equip', 'info', { item: itemName });
    return { ok: true, request: req, durationMs: Date.now() - start };
  } catch (e) {
    return fail(req, start, (e as Error).message);
  }
}

// ───────────────────────── place_block / dig / look_at ─────────────────────────

async function placeBlock(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // ① validate type
  // ② check required fields
  const itemName = req.target?.itemName;
  if (!itemName) return fail(req, start, 'place_block requires target.itemName');
  let refPos = req.target?.referencePosition;
  let faceVector = req.target?.faceVector ?? { x: 0, y: 1, z: 0 };
  // 缺放置点 → 自动算（脚边空格+脚下/侧邻实心块）。算不出则 no_placement_site 交 SubAgent。
  if (!refPos) {
    const place = resolvePlacement(ctx.game, ctx.game.getPosition());
    if (!place) return fail(req, start, 'no_placement_site: 附近找不到可放置的空格');
    refPos = place.refPos;
    faceVector = place.faceVector;
    // 写回 req.target，让后续 lookAt 用 placePos、并让后置验真器查这一格
    req.target = { ...req.target, referencePosition: place.refPos, faceVector: place.faceVector, position: place.placePos };
  }

  // 权威落点由“参考块 + 面法向量”决定；target.position 只用于视线提示，
  // 部分行为（如播种）会把它写成支撑块坐标。
  const placementPos = {
    x: refPos.x + faceVector.x,
    y: refPos.y + faceVector.y,
    z: refPos.z + faceVector.z,
  };
  const inventoryBefore = inventoryCount(ctx, itemName);
  const blockBefore = ctx.game.getBlockAt(placementPos)?.name ?? null;

  // ③ call game adapter
  ctx.bus.publish('atomic.place_block.start', 'info', {
    source: req.source,
    item: itemName,
    refPos,
    faceVector,
  });
  try {
    // equip the item first
    await ctx.actions.equip(itemName, 'hand');
    // look at placement position
    await ctx.actions.lookAt(req.target?.position ?? placementPos, true);
    // get the reference block object and place against it
    const refBlock = ctx.game.getBlockAt(refPos);
    if (!refBlock) {
      return fail(req, start, 'place_block: reference block not found at referencePosition');
    }
    await ctx.actions.placeBlock(refBlock, faceVector);
  } catch (e) {
    const err = (e as Error).message;
    // ④ emit fail event
    ctx.bus.publish('atomic.place_block.fail', 'recoverable', {
      source: req.source,
      item: itemName,
      error: err,
    });
    return fail(req, start, `place_block_failed: ${err}`);
  }

  const settled = await waitForPlacedBlock(ctx, itemName, inventoryBefore, placementPos, blockBefore);
  if (!settled) {
    const inventoryAfter = inventoryCount(ctx, itemName);
    const blockAfter = ctx.game.getBlockAt(placementPos)?.name ?? null;
    ctx.bus.publish('atomic.place_block.fail', 'recoverable', {
      source: req.source,
      item: itemName,
      reason: 'postcondition_unsettled',
      inventoryBefore,
      inventoryAfter,
      blockBefore,
      blockAfter,
      placementPos,
    });
    return fail(
      req,
      start,
      `place_block_unsettled: ${itemName} inventory ${inventoryBefore}→${inventoryAfter}, block ${blockBefore ?? 'unknown'}→${blockAfter ?? 'unknown'}`,
    );
  }
  // ⑤ emit success event · 必须带 source · 上层 Strategy（如 FarmStrategy）靠它推进进度
  ctx.bus.publish('atomic.place_block.success', 'info', {
    source: req.source,
    item: itemName,
  });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

async function waitForPlacedBlock(
  ctx:AtomicContext,
  itemName:string,
  inventoryBefore:number,
  placementPos:Vec3,
  blockBefore:string|null,
):Promise<boolean>{
  for(let attempt=0;attempt<6;attempt+=1){
    if(attempt>0)await ctx.execution.wait(100);
    const inventoryAfter=inventoryCount(ctx,itemName);
    const blockAfter=ctx.game.getBlockAt(placementPos)?.name??null;
    if(inventoryAfter<=inventoryBefore-1&&blockAfter!==null&&blockAfter!==blockBefore)return true;
  }
  return false;
}

function inventoryCount(ctx:AtomicContext,itemName:string):number{
  return ctx.game.getInventoryItems()
    .filter(item=>item.name===itemName)
    .reduce((sum,item)=>sum+item.count,0);
}

async function digBlock(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // ① validate type
  // ② check required fields
  const pos = req.target?.position;
  if (!pos) return fail(req, start, 'dig requires target.position');

  // ③ call game adapter
  ctx.bus.publish('atomic.dig.start', 'info', { source: req.source, pos });
  try {
    await ctx.actions.dig(pos);
  } catch (e) {
    const err = (e as Error).message;
    // ④ emit fail event
    ctx.bus.publish('atomic.dig.fail', 'recoverable', { source: req.source, pos, error: err });
    return fail(req, start, `dig_failed: ${err}`);
  }
  // ⑤ emit success event
  ctx.bus.publish('atomic.dig.success', 'info', { source: req.source, pos });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * 在脚边找一个可放工作台的空格（搬自 ProvisionStrategy.findPlacement 的同步版）：
 * 扫脚同层+上下层的候选格，优先"放在下方块顶面"，否则"贴实心侧邻面"。
 */
function findTablePlacement(ctx: AtomicContext): { refPos: Vec3; faceVector: Vec3; placePos: Vec3 } | null {
  const self = ctx.game.getPosition();
  const fx = Math.floor(self.x), fy = Math.floor(self.y), fz = Math.floor(self.z);
  const dirs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
  const isEmpty = (p: Vec3) => { const b = ctx.game.getBlockAt(p); return !b || b.boundingBox === 'empty'; };
  const isSolid = (p: Vec3) => { const b = ctx.game.getBlockAt(p); return !!b && b.boundingBox === 'block'; };
  for (const dy of [0, 1, -1]) {
    for (const d of dirs) {
      const placePos = { x: fx + d.x, y: fy + dy, z: fz + d.z };
      if (!isEmpty(placePos)) continue;
      const belowPos = { x: placePos.x, y: placePos.y - 1, z: placePos.z };
      if (isSolid(belowPos)) return { refPos: belowPos, faceVector: { x: 0, y: 1, z: 0 }, placePos };
      for (const s of dirs) {
        const refPos = { x: placePos.x + s.x, y: placePos.y, z: placePos.z + s.z };
        if (isSolid(refPos)) return { refPos, faceVector: { x: -s.x, y: 0, z: -s.z }, placePos };
      }
    }
  }
  return null;
}

/**
 * 确保有一个"放在地上、够得着"的功能方块（工作台/熔炉），返回其坐标（失败→null）。
 * 把 ProvisionStrategy 的"找/放/造"能力焊进原子层——根治"合台不放台→no_craftable_recipe"。
 *   ① 附近已有 → 用它
 *   ② 背包有该物品 → 找空位放下
 *   ③ 都没有 → 先合一个（craft 原子会递归补料）→ 再放下
 *
 * BUG-CROSS-02：由 ensureCraftingTable 泛化而来，craft 与 smelt 共用同一套鲁棒逻辑，
 * 避免"工作台会自动备、熔炉却要上游算坐标"的契约不对称。
 */
async function ensureBlock(ctx: AtomicContext, blockName: string, searchDist: number): Promise<Vec3 | null> {
  const findNear = (): Vec3 | null => {
    try {
      return ctx.game.findBlocks({ names: blockName, maxDistance: searchDist, count: 1 })[0] ?? null;
    } catch { return null; }
  };
  // ① 附近已有
  const near = findNear();
  if (near) return near;
  // ② 背包无该物品 → 先合一个（工作台 2x2 无需台；熔炉需 8 圆石）
  //    craft 抛错（材料不足/adapter 不支持）一律视为"造不出"，由调用方转语义失败——
  //    不让底层异常穿透成 LLM 读不懂的错误。
  const hasItem = ctx.game.getInventoryItems().some((i) => i.name === blockName && i.count > 0);
  if (!hasItem) {
    try {
      const cr = await ctx.actions.craft(blockName, 1, null);
      if (!cr.ok) return null; // 通常是材料不足
    } catch {
      return null;
    }
  }
  // ③ 找空位放下
  const place = findTablePlacement(ctx);
  if (!place) return null;
  try {
    await ctx.actions.equip(blockName, 'hand');
    await ctx.actions.lookAt(place.placePos, true);
    const refBlock = ctx.game.getBlockAt(place.refPos);
    if (!refBlock) return null;
    await ctx.actions.placeBlock(refBlock, place.faceVector);
  } catch {
    return null;
  }
  // 放完回查：放置点已是目标块 → 用它；否则再扫一次附近兜底
  const at = ctx.game.getBlockAt(place.placePos);
  if (at && at.name === blockName) return place.placePos;
  return findNear();
}

/** 确保有一张够得着的工作台（兑现 craft 工具说明里的 needTable） */
async function ensureCraftingTable(ctx: AtomicContext): Promise<Vec3 | null> {
  return ensureBlock(ctx, 'crafting_table', tuning().craft.tableSearchDist);
}

/** 确保有一座够得着的熔炉（BUG-CROSS-02：smelt 自洽，不再要求上游算坐标） */
async function ensureFurnace(ctx: AtomicContext): Promise<Vec3 | null> {
  return ensureBlock(ctx, 'furnace', tuning().smelt.furnaceSearchDist);
}

/** 背包里某物品现有数量 */
function invHave(ctx: AtomicContext, name: string): number {
  return ctx.game.getInventoryItems().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

/** 当前背包的 InventoryView 快照（craft/smelt 共用 · 喂给 RecipeResolver / pickFuel） */
function invViewOf(ctx: AtomicContext): InventoryView {
  return ({ items: ctx.game.getInventoryItems().map((i) => ({ name: i.name, count: i.count })) }) as unknown as InventoryView;
}

/**
 * 在 craft 原子内就地采集某材料到目标数量（挖源方块 → 掉落 → 踩点拾取）。
 * 让 craft 成为完整「产出 X」原语：RecipeResolver 算出需采集的材料后，原子直接挖，
 * 不再依赖 GoalAgent LLM 自己组合 locate+gather_block（实测 deepseek 不可靠，6 轮空转弃疗）。
 */
async function gatherMaterialInline(
  ctx: AtomicContext,
  material: string,
  target: number,
): Promise<{ ok: boolean; reason?: string }> {
  const cfg = tuning().craft;
  const src = ctx.game.getItemSource(material);
  if (!src) return { ok: false, reason: `no_source:${material}` };
  let guard = 0;
  while (invHave(ctx, material) < target && guard < cfg.maxGatherBlocks) {
    guard++;
    const found = ctx.game.findBlocks({ names: src.block, maxDistance: cfg.gatherSearchDist, count: 8 });
    if (found.length === 0) return { ok: false, reason: `no_block_nearby:${src.block}` };
    let minedOne = false;
    for (const pos of found) {
      if (src.requiredTool) { try { await ctx.actions.equip(src.requiredTool, 'hand'); } catch { /* 无工具则空手试 */ } }
      await ctx.nav.goto(
        { type: 'block', position: pos, range: 1 },
        { thinkTimeout: cfg.tableApproachThinkMs, totalTimeout: cfg.tableApproachTimeoutMs },
      ).catch(() => { /* 走不到换下一块 */ });
      const before = invHave(ctx, material);
      try { await ctx.actions.dig(pos); } catch { continue; }
      // 踩到方块位置触发 mineflayer 自动拾取
      await ctx.nav.goto({ type: 'block', position: pos, range: 0 }, { thinkTimeout: 1500, totalTimeout: 4000 }).catch(() => {});
      if (invHave(ctx, material) > before) { minedOne = true; break; }
    }
    if (!minedOne) return { ok: false, reason: `mine_failed:${src.block}` };
  }
  return invHave(ctx, material) >= target ? { ok: true } : { ok: false, reason: `gather_incomplete:${material}` };
}

async function craftItem(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // ① validate
  const itemName = req.target?.itemName;
  if (!itemName) return fail(req, start, 'craft requires target.itemName');
  const count = req.target?.count ?? 1;
  // BUG-CROSS-09：count 是上游要求的配方执行次数；递归 Resolver 需要的是目标库存总数。
  // 直接 craft 请求没有新字段时继续沿用旧语义，保持兼容。
  const inventoryTargetCount = req.target?.inventoryTargetCount ?? count;
  const cfg = tuning().craft;

  // ② 递归配方解析器（复用 ProvisionStrategy 同款 RecipeResolver）：
  //    自动把所有"可立即合成"的子材料（木板/木棍/工作台）补齐 + 进阶门槛，再合目标。
  //    根治 GoalAgent 裸调 craft 漏中间材料/漏台 → no_craftable_recipe。
  //    需要去世界采集的步骤（如挖圆石）不在原子内做，明确回报让 GoalAgent 去采。
  const nearbyCache = new Map<string, boolean>();
  const resolver = new RecipeResolver({
    getCraftRecipes: (n, w) => ctx.game.getCraftRecipes(n, w),
    getItemSource: (n) => ctx.game.getItemSource(n),
    isMaterialNearby: (mat) => {
      const c = nearbyCache.get(mat);
      if (c !== undefined) return c;
      const ok = ctx.game.findBlocks({ names: mat, maxDistance: cfg.tableSearchDist, count: 1 }).length > 0;
      nearbyCache.set(mat, ok);
      return ok;
    },
  });
  const invView = (): InventoryView => invViewOf(ctx);

  // ③ 逐步推进：把所有当下可合的步骤做完，直到目标达成 / 需采集 / 受阻
  let lastSig = '';
  for (let i = 0; i < cfg.maxCraftSteps; i++) {
    const step = resolver.nextStep(itemName, inventoryTargetCount, invView());

    if (step.kind === 'done') {
      ctx.bus.publish('atomic.craft.success', 'info', { source: req.source, item: itemName, count });
      return { ok: true, request: req, durationMs: Date.now() - start };
    }
    if (step.kind === 'gather') {
      // 就地采集到「现有 + 本步所需」的目标量（resolver 下一轮会重算继续推进）
      const target = invHave(ctx, step.material) + step.count;
      const g = await gatherMaterialInline(ctx, step.material, target);
      if (!g.ok) return fail(req, start, `craft_failed: 采集 ${step.material}×${step.count} 失败（${g.reason}）`);
      // 进度护栏复用下方签名比对，这里直接进入下一轮 resolve
      const sig = ctx.game.getInventoryItems().map((it) => `${it.name}:${it.count}`).sort().join('|');
      if (sig === lastSig) return fail(req, start, `craft_stuck: 采集 ${step.material} 后库存无变化`);
      lastSig = sig;
      continue;
    }
    if (step.kind === 'smelt') {
      // BUG-CROSS-02：就地熔炼（与 gather 分支同构）。
      // resolver 已算好 input/fuel，过去在此 bail 并把 fuel 丢掉 → GoalAgent 只能裸调 smelt
      // → 撞 fuelName/tablePos 硬校验 → 烧光 attempt 预算 → need_owner。现在直接做完。
      const furnacePos = await ensureFurnace(ctx);
      if (!furnacePos) {
        return fail(req, start, `craft_failed: 需熔炼 ${step.item} 但附近无熔炉且造不出（需 8 圆石）`);
      }
      await ctx.nav.goto(
        { type: 'block', position: furnacePos, range: tuning().smelt.furnaceApproachRange },
        { thinkTimeout: tuning().smelt.furnaceApproachThinkMs, totalTimeout: tuning().smelt.furnaceApproachTimeoutMs },
      ).catch(() => { /* 走不到也试一次，失败由下方统一报 */ });
      ctx.bus.publish('atomic.smelt.start', 'info', {
        source: req.source, input: step.input, fuel: step.fuel, count: step.count, pos: furnacePos, viaCraft: true,
      });
      let sr;
      try {
        sr = await ctx.actions.smelt(furnacePos, step.input, step.fuel, step.count);
      } catch (e) {
        const err = (e as Error).message;
        ctx.bus.publish('atomic.smelt.fail', 'recoverable', { source: req.source, input: step.input, error: err });
        return fail(req, start, `craft_failed: 熔炼 ${step.item} 出错（${err}）`);
      }
      if (!sr.ok) {
        ctx.bus.publish('atomic.smelt.fail', 'recoverable', { source: req.source, input: step.input, error: sr.reason });
        return fail(req, start, `craft_failed: 熔炼 ${step.item} 失败（${sr.reason}）`);
      }
      ctx.bus.publish('atomic.smelt.success', 'info', {
        source: req.source, input: step.input, fuel: step.fuel, produced: sr.produced, viaCraft: true,
      });
      // 进度护栏：熔炼后库存签名必须变化，否则判死循环
      const sig = ctx.game.getInventoryItems().map((it) => `${it.name}:${it.count}`).sort().join('|');
      if (sig === lastSig) return fail(req, start, `craft_stuck: 熔炼 ${step.item} 后库存无变化`);
      lastSig = sig;
      continue;
    }
    if (step.kind === 'blocked') {
      return fail(req, start, `craft_blocked: ${step.reason}`);
    }

    // step.kind === 'craft'：必要时备台（找/放/造一张并走到台前），再合
    let tablePos: Vec3 | null = i === 0 ? (req.target?.tablePos ?? null) : null;
    if (!tablePos && step.needTable) {
      tablePos = await ensureCraftingTable(ctx);
      if (!tablePos) {
        ctx.bus.publish('atomic.craft.fail', 'recoverable', { source: req.source, item: step.item, error: 'no_table_available' });
        return fail(req, start, 'craft_failed: need_table_but_unavailable（需要工作台但找不到/放不下/材料不足）');
      }
      await ctx.nav.goto(
        { type: 'block', position: tablePos, range: cfg.tableApproachRange },
        { thinkTimeout: cfg.tableApproachThinkMs, totalTimeout: cfg.tableApproachTimeoutMs },
      ).catch(() => { /* 走不到也试合一次，失败由下方统一报 */ });
    }

    ctx.bus.publish('atomic.craft.start', 'info', {
      source: req.source, item: step.item, count: step.count, hasTable: !!tablePos, viaResolver: step.item !== itemName,
    });
    let result;
    try {
      result = await ctx.actions.craft(step.item, step.count, tablePos);
    } catch (e) {
      const err = (e as Error).message;
      ctx.bus.publish('atomic.craft.fail', 'recoverable', { source: req.source, item: step.item, error: err });
      return fail(req, start, `craft_failed: ${err}（做 ${step.item}）`);
    }
    if (!result.ok) {
      ctx.bus.publish('atomic.craft.fail', 'recoverable', { source: req.source, item: step.item, error: result.reason });
      return fail(req, start, `craft_failed: ${result.reason}（做 ${step.item}）`);
    }

    // 进度护栏：合成后库存签名必须变化，否则判死循环
    const sig = ctx.game.getInventoryItems().map((it) => `${it.name}:${it.count}`).sort().join('|');
    if (sig === lastSig) return fail(req, start, `craft_stuck: 合成 ${step.item} 后库存无变化`);
    lastSig = sig;
  }

  return fail(req, start, `craft_failed: 超过 ${cfg.maxCraftSteps} 步仍未做出 ${itemName}`);
}

/** smelt · 熔炼（FEAT-L3-06）：开炉→放料+燃料→等产出→取出 */
async function smeltItem(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // ① 校验 + 自洽推导（BUG-CROSS-02）
  //    只有 itemName 是真正不可推导的意图；燃料与熔炉都是"背包与世界的事实"，由原子自己解决。
  //    显式传入优先 —— ProvisionStrategy 走 override 路径，行为完全不变。
  const cfg = tuning().smelt;
  const input = req.target?.itemName;
  const count = req.target?.count ?? 1;
  if (!input) return fail(req, start, 'smelt requires target.itemName (input)');

  // ①.1 燃料：显式传入 > 从背包推导 > 就地采原木当燃料
  let fuel = req.target?.fuelName ?? pickFuel(invViewOf(ctx), { excludeName: input, needUnits: count });
  if (!fuel) {
    // 背包一点燃料都没有 → 就地采原木（resolver 的同款策略，只是这里直接执行）
    const g = await gatherMaterialInline(ctx, 'oak_log', cfg.fuelGatherLogs);
    if (!g.ok) {
      // 语义失败（可执行）· 而非 'requires target.fuelName' 这种 LLM 无从理解的契约错误
      return fail(req, start, `smelt_need_fuel: 背包无燃料且就地采木失败（${g.reason}）· 需煤/木炭/木板/原木`);
    }
    fuel = pickFuel(invViewOf(ctx), { excludeName: input, needUnits: count });
    if (!fuel) return fail(req, start, 'smelt_need_fuel: 背包无燃料（需煤/木炭/木板/原木）');
  }

  // ①.2 熔炉：显式传入 > 自动找/放/造（对齐 craft 的 ensureCraftingTable）
  const furnacePos = req.target?.tablePos ?? await ensureFurnace(ctx);
  if (!furnacePos) {
    ctx.bus.publish('atomic.smelt.fail', 'recoverable', { source: req.source, input, error: 'no_furnace_available' });
    return fail(req, start, 'smelt_need_furnace: 附近无熔炉且造不出（需 8 圆石）');
  }

  // ② emit start
  ctx.bus.publish('atomic.smelt.start', 'info', { source: req.source, input, fuel, count, pos: furnacePos });

  // ②.5 先走到熔炉旁（openFurnace 需在交互距离内，否则 windowOpen 超时——真服实证）
  try {
    await ctx.nav.goto(
      { type: 'block', position: furnacePos, range: cfg.furnaceApproachRange },
      { thinkTimeout: cfg.furnaceApproachThinkMs, totalTimeout: cfg.furnaceApproachTimeoutMs },
    );
  } catch { /* 尽力靠近，开炉时再判 */ }
  // 走完仍够不到（够不到的旧炉）→ 快速失败，别耗 20s windowOpen 超时空转
  {
    const sp = ctx.game.getPosition();
    const fdist = Math.hypot(furnacePos.x - sp.x, furnacePos.y - sp.y, furnacePos.z - sp.z);
    if (fdist > cfg.furnaceMaxDist) {
      ctx.bus.publish('atomic.smelt.fail', 'recoverable', { source: req.source, input, error: 'furnace_unreachable' });
      return fail(req, start, `smelt_failed: furnace_unreachable(dist=${fdist.toFixed(1)})`);
    }
  }

  // ③ call adapter
  let result;
  try {
    result = await ctx.actions.smelt(furnacePos, input, fuel, count);
  } catch (e) {
    const err = (e as Error).message;
    ctx.bus.publish('atomic.smelt.fail', 'recoverable', { source: req.source, input, error: err });
    return fail(req, start, `smelt_failed: ${err}`);
  }

  // ④ failure
  if (!result.ok) {
    ctx.bus.publish('atomic.smelt.fail', 'recoverable', { source: req.source, input, error: result.reason });
    return fail(req, start, `smelt_failed: ${result.reason}`);
  }

  // ⑤ success（带 produced · 上层靠它推进）
  ctx.bus.publish('atomic.smelt.success', 'info', { source: req.source, input, fuel, produced: result.produced });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * walk · 朝目标点方向直接走（不寻路）· 探索/脱困用。
 * 面向 target.position 后开 forward+sprint+jump 走 durationMs，然后停。
 * 比 pathfinder 可靠（不会因为目标点在空中/Y不对而"秒成功不动"）。
 */
async function walkToward(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const pos = req.target?.position;
  if (!pos) return fail(req, start, 'walk requires target.position');
  const ms = Math.min(Math.max(req.target?.durationMs ?? 2500, 500), 6000);
  const before = ctx.game.getPosition();
  ctx.bus.publish('atomic.walk.start', 'info', { to: pos, ms });
  // 关键：先停 pathfinder + 清控制键，释放它对移动的占用，否则残留 goal 会和手动 forward 打架

  try { await ctx.nav.stop(); } catch { /* ignore */ }
  await ctx.actions.clearControlStates();

  // ① 先用 pathfinder GoalXZ 真实穿越地形到目标列（翻坎/下坡/绕崖/必要时挖穿）——
  //   手动走在山地崖谷会卡死；GoalXZ 强制走到该 X/Z，不会对空中点秒成功。临时开 canDig。
  try {
    ctx.nav.setMovementOptions({ canDig: true });
    await ctx.nav.goto({ type: 'xz', x: pos.x, z: pos.z }, { thinkTimeout: 4000, totalTimeout: Math.min(ms + 6000, 14000) });
  } catch { /* 走不到就手动兜底 */ } finally {
    try { ctx.nav.setMovementOptions({ canDig: false }); } catch { /* ignore */ }
  }
  const afterNav = ctx.game.getPosition();
  if (Math.hypot(afterNav.x - before.x, afterNav.z - before.z) > 4) {
    // pathfinder 已带着真实位移 → 探索成功，不必再手动走
    const moved0 = Math.hypot(afterNav.x - before.x, afterNav.z - before.z);
    ctx.bus.publish('atomic.walk.end', 'info', { moved: Math.round(moved0 * 10) / 10, via: 'pathfinder_xz' });
    return { ok: true, request: req, durationMs: Date.now() - start };
  }

  // ② pathfinder 没挪动（卡崖/超时）→ 手动走 + 挖穿兜底
  try {
    await ctx.actions.lookAt({ x: pos.x, y: before.y, z: pos.z }, true); // 水平面向目标
    await ctx.actions.setControlState('forward', true);
    await ctx.actions.setControlState('sprint', true);
    // 周期性脉冲跳跃翻小坎（连续按住 jump 反而原地弹跳不前进）
    const jumpEnd = Date.now() + ms;
    let lastPos = ctx.game.getPosition();
    let lastCheck = Date.now();
    while (Date.now() < jumpEnd) {
      // ★ 岩浆/火安全：正前方/脚下是岩浆火 → 立刻停走、后退（真服实证：bot 走进岩浆 2 秒烧死丢全装）
      if (lavaAhead(ctx, ctx.game.getPosition(), pos)) {
        await ctx.actions.setControlState('forward', false);
        await ctx.actions.setControlState('sprint', false);
        ctx.bus.publish('atomic.walk.hazard', 'recoverable', { hazard: 'lava' });
        // 朝来路后退一下，离开岩浆边缘
        await ctx.actions.lookAt({ x: before.x, y: before.y, z: before.z }, true);
        await ctx.actions.setControlState('back', true);
        await ctx.execution.wait(600);
        await ctx.actions.setControlState('back', false);
        break;
      }
      await ctx.actions.setControlState('jump', true);
      await ctx.execution.wait(150);
      await ctx.actions.setControlState('jump', false);
      await ctx.execution.wait(450);
      // 每 ~1.2s 查一次：卡住没前进 → 挖穿正前方挡路的地形块（破"原地冻住挪不动"根因）
      if (Date.now() - lastCheck > 1150) {
        const now = ctx.game.getPosition();
        if (Math.hypot(now.x - lastPos.x, now.z - lastPos.z) < 0.4) {
          await digForward(ctx, now, pos);
        }
        lastPos = now;
        lastCheck = Date.now();
      }
    }
  } finally {
    await ctx.actions.setControlState('forward', false);
    await ctx.actions.setControlState('sprint', false);
    await ctx.actions.setControlState('jump', false);
  }
  const after = ctx.game.getPosition();
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  ctx.bus.publish('atomic.walk.end', 'info', { moved: Math.round(moved * 10) / 10 });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/** 可安全挖穿的地形块（卡住时清挡路用）· 只挖普通地形，绝不碰门/箱/矿/贵重/岩浆水 */
const WALK_DIGGABLE = /stone|dirt|grass_block|sand|gravel|andesite|diorite|granite|deepslate|tuff|clay|mud|terracotta|netherrack|cobble|moss|podzol|coarse|snow/;

/** 正前方/脚下是否有岩浆/火/岩浆块（走过去会烧死）· 朝目标方向探 2 格 + 脚下 */
function lavaAhead(
  ctx: AtomicContext,
  pos: { x: number; y: number; z: number },
  target: { x: number; z: number },
): boolean {
  const HAZARD = /lava|fire|magma_block/;
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
  const sz = sx === 0 ? Math.sign(dz) : (Math.abs(dz) > Math.abs(dx) * 0.5 ? Math.sign(dz) : 0);
  const probes = [
    { x: fx, y: fy - 1, z: fz },                       // 脚下
    { x: fx + sx, y: fy, z: fz + sz },                  // 正前脚位
    { x: fx + sx, y: fy - 1, z: fz + sz },              // 正前脚下
    { x: fx + sx * 2, y: fy, z: fz + sz * 2 },          // 再前一格
    { x: fx + sx * 2, y: fy - 1, z: fz + sz * 2 },      // 再前脚下
  ];
  for (const p of probes) {
    const b = ctx.game.getBlockAt(p);
    if (b && HAZARD.test(b.name)) return true;
  }
  return false;
}

/** 卡住时挖掉正前方（朝目标方向）2 高挡路块，让 walk 能推进 */
async function digForward(
  ctx: AtomicContext,
  pos: { x: number; y: number; z: number },
  target: { x: number; z: number },
): Promise<void> {
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
  const sz = sx === 0 ? Math.sign(dz) : (Math.abs(dz) > Math.abs(dx) * 0.5 ? Math.sign(dz) : 0);
  if (sx === 0 && sz === 0) return;
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const nx = fx + sx, nz = fz + sz;
  for (const dy of [1, 0]) { // 先头顶后脚位，开 2 高通道
    const t = { x: nx, y: fy + dy, z: nz };
    const b = ctx.game.getBlockAt(t);
    if (b && b.boundingBox === 'block' && WALK_DIGGABLE.test(b.name) && !/lava|water/.test(b.name)) {
      try { await ctx.actions.dig(t); } catch { /* ignore */ }
    }
  }
}

/** 可用作垫脚的方块（背包里有就垫，优先廉价的） */
const PILLAR_BLOCKS = [
  'dirt', 'cobblestone', 'stone', 'grass_block', 'sand', 'gravel', 'netherrack',
  'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'oak_log', 'spruce_log', 'birch_log',
];

function inPit(ctx: AtomicContext, pos: Vec3): boolean {
  return isTrappedInPit(ctx.game, pos, { safeDrop: tuning().escape.safeDrop });
}

/**
 * escape_pit · 脱困：从自己挖的/掉进的坑里爬出来。
 * 策略①垫脚爬出：背包有可垫方块 → 看脚下、跳起、在脚位放方块、落到新块上，逐格升高直到不再被墙围。
 * 策略②挖墙突围：没方块可垫 → 挖正前方 2 格高的洞 + 走出去。
 * 出坑后再朝开阔方向冲两步彻底离开坑口。
 */
async function escapePit(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const startPos = ctx.game.getPosition();
  ctx.bus.publish('atomic.escape_pit.start', 'info', { from: roundPos(startPos) });

  try { await ctx.nav.stop(); } catch { /* ignore */ }
  await ctx.actions.clearControlStates();

  let climbed = 0;
  let dug = 0;
  let noProgress = 0;
  let targetSurfaceY: number | null = null;
  try {
    for (let i = 0; i < 12; i++) {
      const before = ctx.game.getPosition();
      const exit = findPitExit(ctx.game, before, { safeDrop: tuning().escape.safeDrop });
      if (exit) {
        // Atomic 可能在导航已把角色抬高一格后才接管。记录最后一个 step-up 的
        // 真实地表高度，避免用固定“相对起点上升 1.5 格”误判已脱困。
        if (exit.mode === 'step_up') targetSurfaceY = Math.floor(before.y) + 1;
        break;
      }
      const fx = Math.floor(before.x), fy = Math.floor(before.y), fz = Math.floor(before.z);

      const inv = ctx.game.getInventoryItems();
      const blk = inv.find(it => PILLAR_BLOCKS.includes(it.name) && it.count > 0);

      if (blk) {
        // —— 策略①：垫脚爬升一格 ——
        try { await ctx.actions.equip(blk.name, 'hand'); } catch { /* ignore */ }
        // 看向脚下（pitch ≈ +90°）才能把方块放在脚位
        await ctx.actions.look(ctx.game.getOrientation().yaw, Math.PI / 2 - 0.03, true);
        await ctx.actions.setControlState('jump', true);
        // 等身体跳离当前格再放（脚位空出来才放得下）
        const apex = Date.now() + 500;
        while (Date.now() < apex && ctx.game.getPosition().y < fy + 0.5) await ctx.execution.wait(25);
        const ref = ctx.game.getBlockAt({ x: fx, y: fy - 1, z: fz });
        if (ref && ref.boundingBox === 'block') {
          try { await ctx.actions.placeBlock(ref, { x: 0, y: 1, z: 0 }); } catch { /* ignore */ }
        }
        await ctx.execution.wait(120);
        await ctx.actions.setControlState('jump', false);
        await ctx.execution.wait(360); // 落到新垫块上
        if (Math.floor(ctx.game.getPosition().y) > fy) climbed++;
      } else {
        // —— 策略②：开凿上坡（保留相邻同层方块作踏脚，挖 y+1/y+2 净空）——
        // BUG-CROSS-27：旧实现挖 y/y+1 后平走，只打开同高度侧洞；inPit 会提前变 false，
        // 但角色仍在地表下。现在构造一格上坡并 jump-forward，随后 stepToOpen 再上地表。
        const dir = pickWallDir(ctx, before) ?? [1, 0];
        for (const dy of [2, 1]) {
          const t = { x: fx + dir[0], y: fy + dy, z: fz + dir[1] };
          const b = ctx.game.getBlockAt(t);
          if (b && b.boundingBox === 'block' && !/lava|water|bedrock/i.test(b.name)) {
            try { await ctx.actions.dig(t); dug++; } catch { /* ignore */ }
          }
        }
        await ctx.actions.lookAt({ x: fx + dir[0], y: before.y + 1, z: fz + dir[1] }, true);
        await ctx.actions.setControlState('jump', true);
        await ctx.actions.setControlState('forward', true);
        await ctx.actions.setControlState('sprint', true);
        await ctx.execution.wait(900);
        await ctx.actions.setControlState('sprint', false);
        await ctx.actions.setControlState('forward', false);
        await ctx.actions.setControlState('jump', false);
      }

      const afterAttempt = ctx.game.getPosition();
      const moved = Math.hypot(
        afterAttempt.x - before.x,
        afterAttempt.y - before.y,
        afterAttempt.z - before.z,
      );
      if (moved < 0.2 && inPit(ctx, afterAttempt)) noProgress++;
      else noProgress = 0;
      // 单次 atomic 不在同一无效动作上空转 12 轮；交给 GoalAgent/Strategy 的统一重试预算。
      if (noProgress >= 3) break;
    }
    // 爬到坑沿后，朝开阔方向冲两步彻底离开坑口
    await stepToOpen(req, ctx);
  } finally {
    await ctx.actions.clearControlStates();
  }

  const end = ctx.game.getPosition();
  const dy = Math.round((end.y - startPos.y) * 10) / 10;
  // BUG-CROSS-27：同层侧洞不得成功；同时兼容 Atomic 在已部分上升后才接管。
  // 末端 chunk/block 视图可能短暂滞后，因此保留已观测到的 step-up 地表高度作物理证据。
  const rise = end.y - startPos.y;
  const reachedObservedSurface = targetSurfaceY != null && end.y >= targetSurfaceY - 0.3;
  const escaped = rise >= 0.5 && (
    !inPit(ctx, end)
    || reachedObservedSurface
    || rise >= 1.5
  );
  ctx.bus.publish('atomic.escape_pit.end', 'info', {
    escaped, climbed, dug, dy, targetSurfaceY, reachedObservedSurface, to: roundPos(end),
  });
  return escaped
    ? { ok: true, request: req, durationMs: Date.now() - start }
    : fail(req, start, 'escape_pit_failed:still_trapped');
}

/** 选一个有墙（头顶实心）的水平方向用于挖墙突围 */
function pickWallDir(ctx: AtomicContext, pos: { x: number; y: number; z: number }): [number, number] | null {
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const head = ctx.game.getBlockAt({ x: fx + d[0], y: fy + 1, z: fz + d[1] });
    if (head && head.boundingBox === 'block') return d;
  }
  return null;
}

/** 出坑后朝一个两格全空（可走）的方向冲两步，彻底离开坑口 */
async function stepToOpen(req: ActionRequest, ctx: AtomicContext): Promise<void> {
  const p = ctx.game.getPosition();
  const exit = findPitExit(ctx.game, p, { safeDrop: tuning().escape.safeDrop });
  if (!exit) return;
  const target = {
    x: Math.floor(p.x) + exit.dx + 0.5,
    y: exit.mode === 'step_up' ? Math.floor(p.y) + 1 : p.y,
    z: Math.floor(p.z) + exit.dz + 0.5,
  };
  const keys = exit.mode === 'step_up'
    ? (['jump', 'forward', 'sprint'] as const)
    : (['forward', 'sprint'] as const);

  await ctx.actions.lookAt(target, true);
  for (const key of keys) await ctx.actions.setControlState(key, true);
  await ctx.execution.wait(exit.mode === 'step_up' ? 900 : 700);
  for (const key of keys) await ctx.actions.setControlState(key, false);
}

function roundPos(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

/**
 * mine_to · 挖隧道凿到已知矿块（支线挖矿）。
 * 解决"矿嵌在石头里、pathfinder 走不到、反复 nav_timeout"——真服实证铁矿采不到的卡点。
 * 朝目标逐步开 2 高通道（向下挖楼梯/向上挖+跳），到可达距离就挖掉目标。带岩浆/水安全检查。
 */
async function mineTo(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const target = req.target?.position;
  if (!target) return fail(req, start, 'mine_to requires target.position');
  const toolName = req.target?.itemName;
  ctx.bus.publish('atomic.mine_to.start', 'info', { source: req.source, target, tool: toolName });

  if (toolName) { try { await ctx.actions.equip(toolName, 'hand'); } catch { /* 空手也挖 */ } }

  const isMineTarget = (block: ReturnType<typeof ctx.game.getBlockAt>): boolean =>
    Boolean(block && block.boundingBox === 'block' && /ore|debris/.test(block.name));
  const readTarget = () => ctx.game.getBlockAt(target);
  const initialBlock = readTarget();
  if (!isMineTarget(initialBlock)) {
    ctx.bus.publish('atomic.mine_to.end', 'recoverable', {
      source: req.source,
      removed: false,
      reason: 'target_missing',
      block: initialBlock?.name ?? null,
    });
    return fail(req, start, `mine_to_target_missing: ${initialBlock?.name ?? 'air'}`);
  }

  // 是否成功只能以世界里的目标矿块已经消失为准。GameView 的 dig 某些实现会吞掉底层异常，
  // 因此绝不能把“调用过 dig”当成成功。
  const tryRemoveTarget = async (): Promise<boolean> => {
    if (!isMineTarget(readTarget())) return true;
    await ctx.actions.lookAt(
      { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 },
      true,
    );
    try { await ctx.actions.dig(target); } catch { /* 下面用新鲜世界状态判定 */ }
    return !isMineTarget(readTarget());
  };

  let removed = false;
  let approachReason: string | undefined;
  let pickupOk: boolean | undefined;
  try {
    const current = ctx.game.getPosition();
    const distanceToCenter = Math.hypot(
      current.x - (target.x + 0.5),
      current.y - (target.y + 0.5),
      current.z - (target.z + 0.5),
    );

    // 近距离先直接挖，避免 Pathfinder 在 canDig 模式下替我们挖掉目标后仍按“到达方块”等待。
    // Design contract: direct-interaction radius is 4.25 blocks (safe margin below the
    // protocol reach limit), otherwise boundary lookAt/dig attempts fall into a long
    // approach timeout instead of the standable-neighbor path.
    if (distanceToCenter <= 4.25) removed = await tryRemoveTarget();

    if (!removed) {
      try { ctx.nav.setMovementOptions({ canDig: true }); } catch { /* ignore */ }
      const rr = await ctx.nav.goto(
        // 实心方块旁可站位置到方块中心通常约 1.58 格；range=1 没有可满足解。
        { type: 'block', position: target, range: 2 },
        { thinkTimeout: 6000, totalTimeout: 26000 },
      );
      approachReason = rr.reason;
      // Pathfinder 可能已经挖掉目标；若还在，则从现在的位置显式挖掘。
      removed = !isMineTarget(readTarget()) || await tryRemoveTarget();
    }

    if (removed) {
      // 目标此时是空气。玩家脚底中心无法与整数方块坐标重合，range=0 同样不可达；range=1 足够拾取。
      try { ctx.nav.setMovementOptions({ canDig: false }); } catch { /* ignore */ }
      try {
        const pickup = await ctx.nav.goto(
          { type: 'block', position: target, range: 1 },
          { thinkTimeout: 2000, totalTimeout: 6000 },
        );
        pickupOk = pickup.ok;
      } catch {
        pickupOk = false;
      }
    }
  } finally {
    try { ctx.nav.setMovementOptions({ canDig: false }); } catch { /* ignore */ } // 恢复：日常寻路不乱挖（护门）
    try { await ctx.nav.stop(); } catch { /* ignore */ }
  }

  if (!removed) {
    ctx.bus.publish('atomic.mine_to.end', 'recoverable', {
      source: req.source,
      removed: false,
      approachReason,
      block: readTarget()?.name ?? null,
    });
    return fail(
      req,
      start,
      `mine_to_target_not_removed${approachReason ? `: ${approachReason}` : ''}`,
    );
  }

  ctx.bus.publish('atomic.mine_to.end', 'info', { source: req.source, removed: true, pickupOk });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

async function lookAt(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // ① validate type
  // ② check required fields · 支持 position 或 entityId（combat 等用 entityId 看向目标）
  let pos = req.target?.position;
  if (!pos && req.target?.entityId != null) {
    const ent = ctx.game.getEntityById(req.target.entityId);
    if (ent) pos = ent.position;
  }
  if (!pos) return fail(req, start, 'look_at requires target.position or target.entityId');

  // ③ call game adapter (force=true)
  ctx.bus.publish('atomic.look_at.start', 'info', { pos });
  try {
    await ctx.actions.lookAt(pos, true);
  } catch (e) {
    const err = (e as Error).message;
    // ④ emit fail event
    ctx.bus.publish('atomic.look_at.fail', 'recoverable', { pos, error: err });
    return fail(req, start, `look_at_failed: ${err}`);
  }
  // ⑤ emit success event
  ctx.bus.publish('atomic.look_at.success', 'info', { pos });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── toss_item（FEAT-L3-13 给玩家递物品）─────────────────────────

async function tossItem(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const itemName = req.target?.itemName;
  if (!itemName) return fail(req, start, 'toss_item requires target.itemName');
  const count = req.target?.count;

  // ① 背包确实有该物品才扔（防假成功：没有就明确失败，不空扔）
  const have = ctx.game.getInventoryItems()
    .filter(i => i.name === itemName)
    .reduce((s, i) => s + i.count, 0);
  if (have <= 0) return fail(req, start, `no_item: 背包里没有 ${itemName}`);

  // ② 有明确接收目标时优先读实时实体位置，并给朝向包一个短稳定窗口。
  // Mineflayer 本地 yaw 已更新不代表服务端在紧随其后的 drop 包前已经应用朝向；
  // 不等待会偶发把物品沿旧朝向扔到主人反方向。
  const hasDeliveryTarget = req.target?.position != null || req.target?.entityId != null;
  let pos = resolveTossTarget(req, ctx);
  if (pos) {
    try {
      await ctx.actions.lookAt(pos, true);
      await ctx.execution.wait(100);
      pos = resolveTossTarget(req, ctx) ?? pos;
      await ctx.actions.lookAt(pos, true);
    } catch { /* 后续地面差量门会拒绝未送达，不在这里假成功 */ }
  }
  const droppedBefore = hasDeliveryTarget ? droppedItemCounts(ctx.game, itemName) : null;

  // ③ 扔出（game.toss 返回实际扔出数量）
  ctx.bus.publish('atomic.toss_item.start', 'info', { item: itemName, count: count ?? 'all', toward: pos });
  let tossed = 0;
  try {
    tossed = await ctx.actions.toss(itemName, count);
  } catch (e) {
    return fail(req, start, `toss_failed: ${(e as Error).message}`);
  }
  if (tossed <= 0) return fail(req, start, `toss_nothing: ${itemName} 一个都没扔出`);
  const settleMs = Math.max(0, tuning().atomic.tossSettleMs);
  if (settleMs > 0) {
    await ctx.execution.wait(settleMs);
    const remaining = ctx.game.getInventoryItems()
      .filter(i => i.name === itemName)
      .reduce((sum, i) => sum + i.count, 0);
    if (remaining > have - tossed) {
      return fail(req, start, `toss_reacquired_or_unsettled: ${itemName} ${have}→${remaining}`);
    }
  }
  if (droppedBefore) {
    const settledTarget = resolveTossTarget(req, ctx) ?? pos;
    const lingering = ctx.game.getEntities().filter(entity =>
      entity.droppedItem?.name === itemName
      && entity.droppedItem.count > (droppedBefore.get(entity.id) ?? 0));
    const outsidePickupRadius = lingering.filter(entity => !settledTarget
      || distance(entity.position, settledTarget) > 1.5);
    if (outsidePickupRadius.length > 0) {
      const locations = outsidePickupRadius.map(entity =>
        `${entity.id}@${entity.position.x.toFixed(2)},${entity.position.y.toFixed(2)},${entity.position.z.toFixed(2)}`);
      return fail(req, start, `delivery_unverified: ${itemName} remains outside recipient pickup radius (${locations.join(';')})`);
    }
  }
  ctx.bus.publish('atomic.toss_item.success', 'info', { item: itemName, tossed });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function resolveTossTarget(req: ActionRequest, ctx: AtomicContext): Vec3 | undefined {
  if (req.target?.entityId != null) {
    const live = ctx.game.getEntityById(req.target.entityId)?.position;
    if (live) return live;
  }
  return req.target?.position ?? ctx.getWorld().owner?.position ?? undefined;
}

function droppedItemCounts(game: GameView, itemName: string): Map<number, number> {
  return new Map(game.getEntities()
    .filter(entity => entity.droppedItem?.name === itemName)
    .map(entity => [entity.id, entity.droppedItem?.count ?? 0]));
}

// ───────────────────────── fish · FEAT-L3-05 ─────────────────────────

/**
 * fish · 钓鱼骨架版（adapter 暂未暴露 bot.fish()/onFishingFinish）。
 *
 * 流程：装钓竿 → （可选 lookAt 水面） → activateItem 抛钩 →
 *      等 durationMs → deactivateItem 收杆 → success（不保证钓到）。
 *
 * 后续 GameView 加 onFishBite/fish() 后升级"咬钩即收"·ActionType 名稳定不动。
 */
async function fishAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  // ① 校验 · 背包必须有钓竿
  const inv = ctx.game.getInventoryItems();
  const hasRod = inv.some(it => it.name === 'fishing_rod' && it.count > 0);
  if (!hasRod) {
    ctx.bus.publish('atomic.fish.fail', 'recoverable', { source: req.source, reason: 'no_fishing_rod' });
    return fail(req, start, 'fish_failed:no_fishing_rod');
  }
  // ② 等待时间 clamp · vanilla 5-30s
  const durationMs = Math.min(Math.max(req.target?.durationMs ?? 12000, 3000), 30000);
  const waterPos = req.target?.position;

  // ③ 装备
  try {
    await ctx.actions.equip('fishing_rod', 'hand');
  } catch (e) {
    return fail(req, start, `fish_failed:equip:${(e as Error).message}`);
  }
  // 看向水面（若给了）
  let lookedAt = false;
  if (waterPos) {
    try { await ctx.actions.lookAt(waterPos, true); lookedAt = true; } catch { /* ignore */ }
  }

  // ④ 抛钩
  ctx.bus.publish('atomic.fish.cast', 'info', { source: req.source, lookedAt });
  try { await ctx.actions.activateItem(false); } catch (e) {
    return fail(req, start, `fish_failed:cast:${(e as Error).message}`);
  }

  // ⑤ 等咬钩窗口
  ctx.bus.publish('atomic.fish.wait', 'info', { source: req.source, ms: durationMs });
  await ctx.execution.wait(durationMs);

  // ⑥ 收杆
  ctx.bus.publish('atomic.fish.reel', 'info', { source: req.source });
  try { await ctx.actions.deactivateItem(); } catch { /* ignore */ }

  ctx.bus.publish('atomic.fish.success', 'info', { source: req.source, durationMs });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── 垂直移动 · FEAT-L3-08 ─────────────────────────

/** 视为"可攀爬"的方块名片段 */
const CLIMBABLE_RE = /ladder|scaffolding|vine|twisting_vines|weeping_vines/;
/** 视为"挖下安全洞"的安全方块（脚下挖完落到 below-1，below-1 必须是这些之一） */
const DIG_DOWN_HAZARD_RE = /lava|water|magma_block|fire/;

/**
 * climb_up · 爬梯/脚手架/藤蔓到 target.y。
 * - 检测站点上方是不是 climbable
 * - 长按 jump 上爬，每 200ms 检查 y；达到 target.y 即停
 * - 5s 看门狗：5s 内 y 没增长 ≥0.9 视为 stall
 */
async function climbUpAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const targetY = req.target?.position?.y;
  if (targetY == null) return fail(req, start, 'climb_up requires target.position.y');

  const before = ctx.game.getPosition();
  ctx.bus.publish('atomic.climb_up.start', 'info', { source: req.source, from: before, targetY });

  // 上方一格必须可攀爬
  const head = ctx.game.getBlockAt({ x: Math.floor(before.x), y: Math.floor(before.y) + 1, z: Math.floor(before.z) });
  if (!head || !CLIMBABLE_RE.test(head.name)) {
    ctx.bus.publish('atomic.climb_up.fail', 'recoverable', { source: req.source, reason: 'not_climbable', head: head?.name });
    return fail(req, start, 'climb_up_failed:not_climbable');
  }

  await ctx.actions.setControlState('jump', true);
  await ctx.actions.setControlState('sneak', false);
  let lastY = before.y;
  let lastProgress = Date.now();
  const deadline = Date.now() + Math.max(5000, (targetY - before.y) * 1500 + 2000);
  try {
    while (Date.now() < deadline) {
      await ctx.execution.wait(200);
      const cur = ctx.game.getPosition();
      if (cur.y >= targetY) {
        ctx.bus.publish('atomic.climb_up.success', 'info', { source: req.source, dy: cur.y - before.y });
        return { ok: true, request: req, durationMs: Date.now() - start };
      }
      if (cur.y - lastY >= 0.4) { lastY = cur.y; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > 5000) {
        ctx.bus.publish('atomic.climb_up.fail', 'recoverable', { source: req.source, reason: 'climb_stalled', y: cur.y });
        return fail(req, start, 'climb_up_failed:climb_stalled');
      }
    }
    ctx.bus.publish('atomic.climb_up.fail', 'recoverable', { source: req.source, reason: 'timeout' });
    return fail(req, start, 'climb_up_failed:timeout');
  } finally {
    await ctx.actions.setControlState('jump', false);
  }
}

/**
 * pillar_up · 原地塔升 count 格。
 * 与 escape_pit 共享同一份 PILLAR_BLOCKS；垫脚块用法一致。
 */
async function pillarUpAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const count = req.target?.count;
  if (count == null || count <= 0) return fail(req, start, 'pillar_up requires target.count > 0');
  const clampedCount = Math.min(count, 32);
  const startY = ctx.game.getPosition().y;
  ctx.bus.publish('atomic.pillar_up.start', 'info', { source: req.source, count: clampedCount });

  let climbed = 0;
  try {
    for (let i = 0; i < clampedCount; i++) {
      const before = ctx.game.getPosition();
      const fx = Math.floor(before.x), fy = Math.floor(before.y), fz = Math.floor(before.z);

      // 挑垫脚块（target.itemName 优先；否则扫背包按 PILLAR_BLOCKS 顺序）
      const inv = ctx.game.getInventoryItems();
      const explicit = req.target?.itemName
        ? inv.find(it => it.name === req.target?.itemName && it.count > 0)
        : null;
      const blk = explicit ?? inv.find(it => PILLAR_BLOCKS.includes(it.name) && it.count > 0);
      if (!blk) {
        if (climbed > 0) {
          ctx.bus.publish('atomic.pillar_up.success', 'info', { source: req.source, climbed, partial: true });
          return { ok: true, request: req, durationMs: Date.now() - start };
        }
        ctx.bus.publish('atomic.pillar_up.fail', 'recoverable', { source: req.source, reason: 'no_pillar_block' });
        return fail(req, start, 'pillar_up_failed:no_pillar_block');
      }

      try { await ctx.actions.equip(blk.name, 'hand'); } catch { /* ignore · 下面 placeBlock 会失败再兜 */ }
      // 看脚下
      await ctx.actions.look(ctx.game.getOrientation().yaw, Math.PI / 2 - 0.03, true);
      await ctx.actions.setControlState('jump', true);
      const apex = Date.now() + 500;
      while (Date.now() < apex && ctx.game.getPosition().y < fy + 0.5) await ctx.execution.wait(25);
      const ref = ctx.game.getBlockAt({ x: fx, y: fy - 1, z: fz });
      let placed = false;
      if (ref && ref.boundingBox === 'block') {
        try { await ctx.actions.placeBlock(ref, { x: 0, y: 1, z: 0 }); placed = true; } catch { /* ignore */ }
      }
      await ctx.execution.wait(120);
      await ctx.actions.setControlState('jump', false);
      await ctx.execution.wait(360);
      if (placed && Math.floor(ctx.game.getPosition().y) > fy) climbed++;
      else {
        // 没升高 → 早退（避免无效循环占执行锁）
        break;
      }
    }
  } finally {
    await ctx.actions.setControlState('jump', false);
  }
  const dy = Math.round((ctx.game.getPosition().y - startY) * 10) / 10;
  ctx.bus.publish('atomic.pillar_up.success', 'info', { source: req.source, climbed, dy });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * dig_down · 楼梯式向下挖 count 格（每次挖正下方 -1 那块，等下落，再循环）。
 * 安全：每步检查 below-1 是不是岩浆/水/虚空 → fail dig_hazard_below。
 */
async function digDownAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const count = req.target?.count;
  if (count == null || count <= 0) return fail(req, start, 'dig_down requires target.count > 0');
  const clampedCount = Math.min(count, 64);
  ctx.bus.publish('atomic.dig_down.start', 'info', { source: req.source, count: clampedCount });

  let dug = 0;
  for (let i = 0; i < clampedCount; i++) {
    const pos = ctx.game.getPosition();
    const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
    const below = { x: fx, y: fy - 1, z: fz };
    const below2 = { x: fx, y: fy - 2, z: fz };
    // 安全：脚下 -1 自身或 -2 是 lava/水/火 → 立即停
    const b1 = ctx.game.getBlockAt(below);
    const b2 = ctx.game.getBlockAt(below2);
    if ((b1 && DIG_DOWN_HAZARD_RE.test(b1.name)) || (b2 && DIG_DOWN_HAZARD_RE.test(b2.name))) {
      ctx.bus.publish('atomic.dig_down.fail', 'recoverable', { source: req.source, reason: 'dig_hazard_below', dug });
      return fail(req, start, `dig_down_failed:dig_hazard_below(${b1?.name ?? '?'}/${b2?.name ?? '?'})`);
    }
    if (!b1 || b1.boundingBox !== 'block') {
      // 已经是空 → 走完？让 bot 自己下落，跳到下次循环
      await ctx.execution.wait(400);
      const after = ctx.game.getPosition();
      if (after.y < pos.y - 0.5) continue; // 下落了一格
      ctx.bus.publish('atomic.dig_down.success', 'info', { source: req.source, dug, reason: 'air_below' });
      return { ok: true, request: req, durationMs: Date.now() - start };
    }
    await ctx.actions.lookAt({ x: below.x + 0.5, y: below.y + 0.5, z: below.z + 0.5 }, true);
    try {
      await ctx.actions.dig(below);
      dug++;
    } catch (e) {
      ctx.bus.publish('atomic.dig_down.fail', 'recoverable', { source: req.source, reason: 'dig_failed', error: (e as Error).message, dug });
      return fail(req, start, `dig_down_failed:dig_failed:${(e as Error).message}`);
    }
    // 等下落
    await ctx.execution.wait(650);
  }
  ctx.bus.publish('atomic.dig_down.success', 'info', { source: req.source, dug });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * place_scaffold · 在指定参考块的某个面放方块。
 * 与 place_block 90% 等价，单列出来是为了语义清晰（"搭桥/搭脚手架"场景）+ 默认面向上。
 */
async function placeScaffoldAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const itemName = req.target?.itemName;
  if (!itemName) return fail(req, start, 'place_scaffold requires target.itemName');
  const faceVector = req.target?.faceVector ?? { x: 0, y: 1, z: 0 };

  // 参考方块：优先 referencePosition，否则脚下
  let refPos = req.target?.referencePosition;
  if (!refPos) {
    const p = ctx.game.getPosition();
    refPos = { x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) };
  }
  ctx.bus.publish('atomic.place_scaffold.start', 'info', { source: req.source, item: itemName, refPos, faceVector });
  try {
    await ctx.actions.equip(itemName, 'hand');
    const ref = ctx.game.getBlockAt(refPos);
    if (!ref) {
      ctx.bus.publish('atomic.place_scaffold.fail', 'recoverable', { source: req.source, reason: 'no_ref_block' });
      return fail(req, start, 'place_scaffold_failed:no_ref_block');
    }
    await ctx.actions.placeBlock(ref, faceVector);
  } catch (e) {
    ctx.bus.publish('atomic.place_scaffold.fail', 'recoverable', { source: req.source, error: (e as Error).message });
    return fail(req, start, `place_scaffold_failed:${(e as Error).message}`);
  }
  ctx.bus.publish('atomic.place_scaffold.success', 'info', { source: req.source, item: itemName });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── 载具 · FEAT-L3-09（骨架） ─────────────────────────

async function mountAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const eid = req.target?.entityId;
  if (eid == null) return fail(req, start, 'mount requires target.entityId');
  try {
    await ctx.actions.mount(eid);
  } catch (e) {
    ctx.bus.publish('atomic.mount.fail', 'recoverable', { source: req.source, error: (e as Error).message });
    return fail(req, start, `mount_failed:${(e as Error).message}`);
  }
  ctx.bus.publish('atomic.mount.success', 'info', { source: req.source, entityId: eid });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

async function dismountAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  try {
    await ctx.actions.dismount();
  } catch (e) {
    ctx.bus.publish('atomic.dismount.fail', 'recoverable', { source: req.source, error: (e as Error).message });
    return fail(req, start, `dismount_failed:${(e as Error).message}`);
  }
  ctx.bus.publish('atomic.dismount.success', 'info', { source: req.source });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── 战斗完善 · FEAT-L3-12 ─────────────────────────

/**
 * kite · 砍一刀立刻后退（拉怪/挂创可贴用）。
 */
async function kiteAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const id = req.target?.entityId;
  if (id == null) return fail(req, start, 'kite requires target.entityId');
  const ent = ctx.game.getEntityById(id);
  if (!ent) return fail(req, start, 'kite_failed:target_not_found');
  const backMs = Math.min(Math.max(req.target?.backDurationMs ?? 600, 100), 2500);

  await ctx.actions.lookAt(ent.position, true);
  await ctx.actions.attack(id);
  ctx.bus.publish('atomic.kite.swing', 'info', { source: req.source, entityId: id, target: ent.name });
  await ctx.actions.setControlState('back', true);
  try {
    await ctx.execution.wait(backMs);
  } finally {
    await ctx.actions.setControlState('back', false);
  }
  ctx.bus.publish('atomic.kite.success', 'info', { source: req.source, entityId: id, backMs });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * block_with_shield · 左手举盾保持 durationMs 然后放下。
 */
async function blockWithShieldAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const inv = ctx.game.getInventoryItems();
  if (!inv.some(it => it.name === 'shield' && it.count > 0)) {
    ctx.bus.publish('atomic.block_with_shield.fail', 'recoverable', { source: req.source, reason: 'no_shield' });
    return fail(req, start, 'block_with_shield_failed:no_shield');
  }
  const durationMs = Math.min(Math.max(req.target?.durationMs ?? 1500, 200), 5000);
  try {
    await ctx.actions.equip('shield', 'off-hand');
  } catch (e) {
    ctx.bus.publish('atomic.block_with_shield.fail', 'recoverable', { source: req.source, error: (e as Error).message });
    return fail(req, start, `block_with_shield_failed:equip:${(e as Error).message}`);
  }
  ctx.bus.publish('atomic.block_with_shield.up', 'info', { source: req.source, durationMs });
  await ctx.actions.activateItem(true);
  try {
    await ctx.execution.wait(durationMs);
  } finally {
    await ctx.actions.deactivateItem();
  }
  ctx.bus.publish('atomic.block_with_shield.success', 'info', { source: req.source });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * bow_shoot · 弓蓄力 drawMs 后放箭。
 */
async function bowShootAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const id = req.target?.entityId;
  if (id == null) return fail(req, start, 'bow_shoot requires target.entityId');
  const ent = ctx.game.getEntityById(id);
  if (!ent) return fail(req, start, 'bow_shoot_failed:target_not_found');

  const inv = ctx.game.getInventoryItems();
  if (!inv.some(it => it.name === 'bow' && it.count > 0)) {
    ctx.bus.publish('atomic.bow_shoot.fail', 'recoverable', { source: req.source, reason: 'no_bow' });
    return fail(req, start, 'bow_shoot_failed:no_bow');
  }
  if (!inv.some(it => /arrow/.test(it.name) && it.count > 0)) {
    ctx.bus.publish('atomic.bow_shoot.fail', 'recoverable', { source: req.source, reason: 'no_arrow' });
    return fail(req, start, 'bow_shoot_failed:no_arrow');
  }
  const drawMs = Math.min(Math.max(req.target?.drawMs ?? 1200, 200), 4000);
  try {
    await ctx.actions.equip('bow', 'hand');
  } catch (e) {
    return fail(req, start, `bow_shoot_failed:equip:${(e as Error).message}`);
  }
  await ctx.actions.lookAt(ent.position, true);
  ctx.bus.publish('atomic.bow_shoot.draw', 'info', { source: req.source, entityId: id, drawMs });
  await ctx.actions.activateItem(false);
  try {
    await ctx.execution.wait(drawMs);
  } finally {
    await ctx.actions.deactivateItem(); // 放箭
  }
  ctx.bus.publish('atomic.bow_shoot.success', 'info', { source: req.source, entityId: id });
  return { ok: true, request: req, durationMs: Date.now() - start };
}

/**
 * crit_jump_attack · 起跳后在下落途中攻击（vanilla 暴击触发）。
 * 简化版：jump=true → 250ms → attack → jump=false。
 */
async function critJumpAttackAtomic(
  req: ActionRequest,
  ctx: AtomicContext,
  start: number,
): Promise<ExecutionResult> {
  const id = req.target?.entityId;
  if (id == null) return fail(req, start, 'crit_jump_attack requires target.entityId');
  const ent = ctx.game.getEntityById(id);
  if (!ent) return fail(req, start, 'crit_jump_attack_failed:target_not_found');

  await ctx.actions.lookAt(ent.position, true);
  await ctx.actions.setControlState('jump', true);
  try {
    await ctx.execution.wait(250);
    await ctx.actions.attack(id);
    ctx.bus.publish('atomic.crit_jump_attack.success', 'info', { source: req.source, entityId: id, target: ent.name });
  } finally {
    await ctx.actions.setControlState('jump', false);
  }
  return { ok: true, request: req, durationMs: Date.now() - start };
}

// ───────────────────────── helpers ─────────────────────────

function fail(req: ActionRequest, start: number, error: string): ExecutionResult {
  return { ok: false, request: req, durationMs: Date.now() - start, error };
}
