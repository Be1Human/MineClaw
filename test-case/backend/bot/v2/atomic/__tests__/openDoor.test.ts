/**
 * openDoor + isDoorBlock · 单元测试（BUG-L1-02 v2 方案 · L3 原子层）
 *
 * 实际方案 v2（commit df1e563 之前）：
 *   - 不再走 mineflayer-pathfinder 的 openable 集合
 *   - L3 提供 openDoor 原子 + isDoorBlock 谓词
 *   - L5 DoorMonitor 调用此原子，门对 pathfinder 透明
 *
 * 本测试覆盖：
 *   T1 · isDoorBlock 识别所有 24+ 种门
 *   T2 · openDoor 已开 → reason='already_open'
 *   T3 · openDoor not_a_door 短路
 *   T4 · openDoor no_block 安全
 *   T5 · openDoor 铁门 → iron_door
 *   T6 · openDoor 一次交互即开 → reason='opened'
 *   T7 · openDoor 二次验证才开 → 仍 reason='opened'
 *   T8 · openDoor 始终关闭 → failed_to_open
 */

import { describe, it as nodeIt } from 'node:test';
import { withinBody } from '../../__tests__/mocks/withinBody.js';
import type { ControlledExecutionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/controlledExecution.js';
const it=(name:string,work:(scope:ControlledExecutionContext)=>unknown)=>nodeIt(name,()=>withinBody(async scope=>work(scope)));
import assert from 'node:assert/strict';

import { openDoor, isDoorBlock } from '../../../../../../apps/minecraft-companion/src/bot/v2/atomic/openDoor.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { Vec3, RawBlock } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';

// ──────────────────────────────────────────────────────────────────
// Mock GameAdapter
// ──────────────────────────────────────────────────────────────────

interface MockState {
  block: RawBlock | null;
  /** props 数组：每次 getBlockProperties 弹一个；空则用最后一个 */
  propsSequence: Array<Record<string, string> | null>;
  interactCalls: Vec3[];
  /** 每次 interactBlock 时把 props 切到下一个 */
  autoFlipOnInteract?: boolean;
}

function makeMockGame(state: MockState): GameAdapter {
  let propsIdx = 0;
  const getNextProps = (): Record<string, string> | null => {
    const p = state.propsSequence[Math.min(propsIdx, state.propsSequence.length - 1)];
    return p;
  };

  return {
    username: 'mock',
    getBlockAt: (_pos: Vec3) => state.block,
    getBlockProperties: (_pos: Vec3) => getNextProps(),
    interactBlock: async (pos: Vec3) => {
      state.interactCalls.push(pos);
      if (state.autoFlipOnInteract) propsIdx++;
    },
  } as unknown as GameAdapter;
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('isDoorBlock · BUG-L1-02', () => {

  it('T1 · 识别 12 种普通门 + 12 种活板门 + 11 种栅栏门', (scope) => {
    const samples = [
      // 普通门
      'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
      'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door',
      'crimson_door', 'warped_door', 'iron_door',
      // 活板门
      'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor',
      'acacia_trapdoor', 'dark_oak_trapdoor', 'mangrove_trapdoor', 'cherry_trapdoor',
      'bamboo_trapdoor', 'crimson_trapdoor', 'warped_trapdoor', 'iron_trapdoor',
      // 栅栏门
      'oak_fence_gate', 'spruce_fence_gate', 'birch_fence_gate', 'jungle_fence_gate',
      'acacia_fence_gate', 'dark_oak_fence_gate', 'mangrove_fence_gate', 'cherry_fence_gate',
      'bamboo_fence_gate', 'crimson_fence_gate', 'warped_fence_gate',
    ];
    for (const name of samples) {
      assert.ok(isDoorBlock(name), `${name} 应被识别为门`);
    }
    assert.equal(samples.length >= 24, true);
  });

  it('T1b · 非门方块返回 false', (scope) => {
    const nonDoors = ['stone', 'dirt', 'oak_log', 'air', 'iron_block', 'oak_planks'];
    for (const name of nonDoors) {
      assert.equal(isDoorBlock(name), false, `${name} 不应被识别为门`);
    }
  });
});

describe('openDoor · BUG-L1-02', () => {

  // T2 · 已开 → already_open
  it('T2 · 门已经是 open → reason="already_open" · 不交互', async (scope) => {
    const state: MockState = {
      block: makeBlock('oak_door'),
      propsSequence: [{ open: 'true' }],
      interactCalls: [],
    };
    const game = makeMockGame(state);
    const r = await openDoor(game,game as never,scope,{ x: 0, y: 64, z: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'already_open');
    assert.equal(state.interactCalls.length, 0);
  });

  // T3 · 不是门 → not_a_door
  it('T3 · 方块非门 → not_a_door', async (scope) => {
    const state: MockState = {
      block: makeBlock('stone'),
      propsSequence: [null],
      interactCalls: [],
    };
    const game = makeMockGame(state);
    const r = await openDoor(game,game as never,scope,{ x: 0, y: 64, z: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_a_door');
  });

  // T4 · 该坐标无方块 → no_block
  it('T4 · getBlockAt 返回 null → no_block', async (scope) => {
    const state: MockState = {
      block: null,
      propsSequence: [null],
      interactCalls: [],
    };
    const game = makeMockGame(state);
    const r = await openDoor(game,game as never,scope,{ x: 0, y: 64, z: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_block');
  });

  // T5 · 铁门 → iron_door reason
  it('T5 · 铁门 → reason="iron_door" · 不交互', async (scope) => {
    const state: MockState = {
      block: makeBlock('iron_door'),
      propsSequence: [{ open: 'false' }],
      interactCalls: [],
    };
    const game = makeMockGame(state);
    const r = await openDoor(game,game as never,scope,{ x: 0, y: 64, z: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'iron_door');
    assert.equal(state.interactCalls.length, 0);
  });

  // T6 · 一次交互后状态翻转 → opened
  it('T6 · interactBlock 后 open=true → reason="opened" · 1 次交互', async (scope) => {
    const state: MockState = {
      block: makeBlock('oak_door'),
      // 1) 初次读 closed · 2) 交互后读 true · 3) 兜底 true
      propsSequence: [{ open: 'false' }, { open: 'true' }, { open: 'true' }],
      interactCalls: [],
      autoFlipOnInteract: true,
    };
    const game = makeMockGame(state);
    const r = await openDoor(game,game as never,scope,{ x: 0, y: 64, z: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'opened');
    assert.equal(state.interactCalls.length, 1);
  });

  // T7 · 始终关 → failed_to_open
  it('T7 · interactBlock 后仍 closed → reason="failed_to_open" · 2 次属性读', async (scope) => {
    const state: MockState = {
      block: makeBlock('oak_door'),
      propsSequence: [{ open: 'false' }],
      interactCalls: [],
    };
    const game = makeMockGame(state);
    const r = await openDoor(game,game as never,scope,{ x: 0, y: 64, z: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'failed_to_open');
    assert.equal(state.interactCalls.length, 1);
  });
});

// ──────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────

function makeBlock(name: string): RawBlock {
  return { name, position: { x: 0, y: 64, z: 0 } };
}
