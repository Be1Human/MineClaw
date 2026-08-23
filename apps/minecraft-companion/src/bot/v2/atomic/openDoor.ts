/**
 * L3 · Atomic · openDoor — 原子开门动作
 *
 * FEAT-CROSS-01
 *
 * 职责：对指定坐标的门方块执行一次开门交互。
 * - 幂等：已开则直接 ok
 * - 验证：交互后等待 + 重新读取属性确认
 * - 不决策：何时调用由 L5 SmartNavStrategy 控制
 */

import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';

// ── 门名单 ──────────────────────────────────────────────

const DOOR_NAMES = new Set([
  'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
  'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door',
  'crimson_door', 'warped_door', 'iron_door',
  'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor',
  'acacia_trapdoor', 'dark_oak_trapdoor', 'mangrove_trapdoor', 'cherry_trapdoor',
  'bamboo_trapdoor', 'crimson_trapdoor', 'warped_trapdoor', 'iron_trapdoor',
  'oak_fence_gate', 'spruce_fence_gate', 'birch_fence_gate', 'jungle_fence_gate',
  'acacia_fence_gate', 'dark_oak_fence_gate', 'mangrove_fence_gate', 'cherry_fence_gate',
  'bamboo_fence_gate', 'crimson_fence_gate', 'warped_fence_gate',
]);

export function isDoorBlock(name: string): boolean {
  return DOOR_NAMES.has(name);
}

// ── 结果类型 ─────────────────────────────────────────────

export interface OpenDoorResult {
  ok: boolean;
  reason: 'already_open' | 'opened' | 'not_a_door' | 'no_block' | 'failed_to_open' | 'iron_door';
}

// ── 核心实现 ─────────────────────────────────────────────

/**
 * 对坐标 pos 处的门执行开门。
 *
 * @returns ok=true 表示门现在是开的（无论是之前就开还是刚打开的）
 */
export async function openDoor(game: GameAdapter, pos: Vec3): Promise<OpenDoorResult> {
  // 1. 读方块
  const block = game.getBlockAt(pos);
  if (!block) return { ok: false, reason: 'no_block' };
  if (!isDoorBlock(block.name)) return { ok: false, reason: 'not_a_door' };

  // 铁门不能手动交互打开（需要红石信号）
  if (block.name === 'iron_door' || block.name === 'iron_trapdoor') {
    return { ok: false, reason: 'iron_door' };
  }

  // 2. 读当前状态
  const props = game.getBlockProperties(pos);
  if (props?.open === 'true') {
    return { ok: true, reason: 'already_open' };
  }

  // 3. 交互开门
  await game.interactBlock(pos);

  // 4. 等待状态同步（MC 服务端 → 客户端需要一两个 tick）
  await sleep(400);

  // 5. 验证
  const propsAfter = game.getBlockProperties(pos);
  if (propsAfter?.open === 'true') {
    return { ok: true, reason: 'opened' };
  }

  // 二次尝试：有些情况下延迟较大
  await sleep(300);
  const propsRetry = game.getBlockProperties(pos);
  if (propsRetry?.open === 'true') {
    return { ok: true, reason: 'opened' };
  }

  return { ok: false, reason: 'failed_to_open' };
}

// ── 工具 ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
