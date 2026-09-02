/**
 * L3 · 原子后置验真（Atomic Postcondition Verification）
 *
 * 修的是框架旧 bug：goalRunner/atomExec 当初故意没给原子配 critic，只信 handler 的 r.ok
 * → "调用没报错就算成功"，放工作台没放上也报成功（石斧 E2E 断点）。
 *
 * 分层（grill 锁定）：
 *   - 原子层只验【物理效果·意图无关】：place→那格变了、dig→方块没了、craft→背包+N、equip→手持变。
 *   - 【意图达成】(挖矿是否真收到圆石 / 打安妮是否服了) 归 task critic(L6-03)，不在此。
 *
 * 三态：pass / fail / unknown。"验不了"≠"失败"——打玩家拿不到血量 → unknown 不阻断。
 * 时机：默认单次读（mineflayer 动作 Promise 多已等服务器 ack），fail 时短轮询兜底（见 atomics.runVerify）。
 * 失败：原子单发不自重试，enforce 档判 fail 交 GoalAgent Recovery 节点；observe 档只告警不阻断。
 */

import type { GameView } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';
import type { ActionRequest, ActionType } from '../types.js';

export type VerifyStatus = 'pass' | 'fail' | 'unknown';
export interface VerifyVerdict {
  status: VerifyStatus;
  reason?: string;
}

export interface AtomVerifier {
  /** 动作前拍快照（只拍本原子要对比的状态：背包数/饱食/血量…）· 可选 */
  snapshot?(req: ActionRequest, game: GameView): unknown;
  /** 动作后回查世界 → 三态。同步纯读，短轮询由 atomics.runVerify 控制。 */
  verify(req: ActionRequest, game: GameView, before: unknown): VerifyVerdict;
}

// ── 小工具 ────────────────────────────────────────────
const isSolid = (b: { boundingBox?: string; name: string } | null): boolean =>
  !!b && b.boundingBox === 'block';
const isEmpty = (b: { boundingBox?: string } | null): boolean =>
  !b || b.boundingBox === 'empty';
function invCount(game: GameView, name: string): number {
  return game.getInventoryItems().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
}
function invTotal(game: GameView): number {
  return game.getInventoryItems().reduce((s, i) => s + i.count, 0);
}

/** 攻击类共用验真器：能读到目标血量就验掉血/消失，读不到(玩家)→unknown */
const attackVerifier: AtomVerifier = {
  snapshot(req, game) {
    const id = req.target?.entityId;
    return id != null ? game.getEntityById(id)?.health : undefined;
  },
  verify(req, game, before) {
    const id = req.target?.entityId;
    if (id == null) return { status: 'unknown' };
    const e = game.getEntityById(id);
    if (!e) return { status: 'pass' };                 // 目标消失 = 击杀/逃离，物理上确有作用
    const beforeHp = before as number | undefined;
    if (e.health === undefined || beforeHp === undefined) return { status: 'unknown' }; // 玩家无血量
    return e.health < beforeHp
      ? { status: 'pass' }
      : { status: 'fail', reason: `目标未掉血 (${beforeHp}→${e.health})` };
  },
};

/**
 * 声明式验真表：每原子声明断言。未列入的原子（say/look_at/stop/follow/移动类自带验真等）
 * 默认 'off'（不在此验），由 tuning.atomic.verifyMode 控制 off/observe/enforce。
 */
export const ATOM_VERIFIERS: Partial<Record<ActionType, AtomVerifier>> = {
  // ── 放置类（石斧①号断点的根治区）──
  place_block: {
    verify(req, game) {
      const item = req.target?.itemName;
      const pos = req.target?.position ?? req.target?.referencePosition;
      if (!item || !pos) return { status: 'unknown', reason: 'no placePos' };
      const b = game.getBlockAt(pos);
      if (b && b.name === item) return { status: 'pass' };
      // item≠block 名的少数情况：那格变实心也算放上了
      if (isSolid(b)) return { status: 'pass' };
      return { status: 'fail', reason: `(${pos.x},${pos.y},${pos.z}) 仍为 ${b?.name ?? 'air'}，期望 ${item}` };
    },
  },
  place_scaffold: {
    verify(req, game) {
      const pos = req.target?.position ?? req.target?.referencePosition;
      if (!pos) return { status: 'unknown' };
      return isSolid(game.getBlockAt(pos))
        ? { status: 'pass' }
        : { status: 'fail', reason: '脚手架格未变实心' };
    },
  },
  // ── 挖/合成/装备/吃（物理事实清晰，默认 enforce）──
  dig: {
    verify(req, game) {
      const pos = req.target?.position;
      if (!pos) return { status: 'unknown' };
      const b = game.getBlockAt(pos);
      return isEmpty(b)
        ? { status: 'pass' }
        : { status: 'fail', reason: `方块未消失，仍为 ${b?.name}` };
    },
  },
  craft: {
    snapshot(req, game) { return invCount(game, String(req.target?.itemName ?? '')); },
    verify(req, game, before) {
      const item = String(req.target?.itemName ?? '');
      if (!item) return { status: 'unknown' };
      const now = invCount(game, item);
      const want = Number(req.target?.count ?? 1);
      // craft 原子语义=「确保拥有 ≥ want 个」：已达成目标数量 或 数量有增长 → pass。
      // （resolver 驱动下，若开局已够则不再合成，此时 now==before 但 now>=want，不能误判失败）
      return (now >= want || now > (before as number))
        ? { status: 'pass' }
        : { status: 'fail', reason: `背包 ${item} 未达成 (有 ${now}/需 ${want})` };
    },
  },
  equip: {
    verify(req, game) {
      const item = req.target?.itemName;
      if (!item) return { status: 'unknown' };
      const held = game.getHeldItem();
      return held?.name === item
        ? { status: 'pass' }
        : { status: 'fail', reason: `手持为 ${held?.name ?? '空'}，期望 ${item}` };
    },
  },
  // FEAT-L3-13 · 扔出物品 = 背包该物品数必须下降（防"调用没报错就算给了"假成功）
  toss_item: {
    snapshot(req, game) { return invCount(game, String(req.target?.itemName ?? '')); },
    verify(req, game, before) {
      const item = String(req.target?.itemName ?? '');
      if (!item) return { status: 'unknown' };
      const now = invCount(game, item);
      return now < (before as number)
        ? { status: 'pass' }
        : { status: 'fail', reason: `背包 ${item} 未减少 (${before}→${now})，没真扔出` };
    },
  },
  eat: {
    snapshot(_req, game) { return game.getFood(); },
    verify(_req, game, before) {
      const b = before as number;
      if (b >= 20) return { status: 'pass' };  // 本就满
      const now = game.getFood();
      return now > b ? { status: 'pass' } : { status: 'fail', reason: `饱食未涨 (${b}→${now})` };
    },
  },
  // ── 战斗/钓鱼/穿甲（易 unknown，默认 observe）──
  attack: attackVerifier,
  crit_jump_attack: attackVerifier,
  bow_shoot: attackVerifier,
  fish: {
    snapshot(_req, game) { return invTotal(game); },
    verify(_req, game, before) {
      return invTotal(game) > (before as number)
        ? { status: 'pass' }
        : { status: 'fail', reason: '未获渔获' };
    },
  },
  equip_best_armor: {
    snapshot(_req, game) {
      const a = game.getArmorItems();
      return [a.head, a.torso, a.legs, a.feet].filter(Boolean).length;
    },
    verify(_req, game, before) {
      const a = game.getArmorItems();
      const now = [a.head, a.torso, a.legs, a.feet].filter(Boolean).length;
      return now >= (before as number)
        ? { status: 'pass' }
        : { status: 'fail', reason: '穿甲数减少' };
    },
  },
};

/**
 * 放置点解算（从 provisionStrategy.findPlacement 下沉·共用）。
 * place_block 缺 referencePosition 时自动找：脚边空格 + 脚下实心块(顶面放) 或 侧邻实心块(侧面放)。
 */
export function resolvePlacement(
  game: GameView,
  selfPos: Vec3,
): { refPos: Vec3; faceVector: Vec3; placePos: Vec3 } | null {
  const fx = Math.floor(selfPos.x), fy = Math.floor(selfPos.y), fz = Math.floor(selfPos.z);
  const dirs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
  const empty = (p: Vec3) => isEmpty(game.getBlockAt(p));
  const solid = (p: Vec3) => isSolid(game.getBlockAt(p));
  for (const dy of [0, 1, -1]) {
    for (const d of dirs) {
      const placePos = { x: fx + d.x, y: fy + dy, z: fz + d.z };
      if (!empty(placePos)) continue;
      const below = { x: placePos.x, y: placePos.y - 1, z: placePos.z };
      if (solid(below)) return { refPos: below, faceVector: { x: 0, y: 1, z: 0 }, placePos };
      for (const s of dirs) {
        const refPos = { x: placePos.x + s.x, y: placePos.y, z: placePos.z + s.z };
        if (solid(refPos)) return { refPos, faceVector: { x: -s.x, y: 0, z: -s.z }, placePos };
      }
    }
  }
  return null;
}
