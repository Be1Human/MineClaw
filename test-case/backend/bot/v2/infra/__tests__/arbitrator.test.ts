/**
 * ActionArbitrator 单元测试 · US-G1
 *
 * 8 个用例覆盖：
 *   ① 单请求无资源 → 通过成为 winner
 *   ② 多请求按优先级排序（高优先级优先）
 *   ③ 资源冲突：两个请求占 movement → 高优先级赢，低优先级拒绝 resource_conflict
 *   ④ 多胜出：movement + say（无资源）→ 同 tick 并行通过
 *   ⑤ 硬抢占：executing=true，新请求 interrupt_level=hard + 更高优先级 → 赢
 *   ⑥ 软不抢：executing=true，interrupt_level=soft → rejected busy:...
 *   ⑦ 前置条件 owner_visible 不满足 → rejected precondition_missing:owner_visible
 *   ⑧ 轻动作 say 在 executing=true 时仍可通过
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ActionArbitrator } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/heartbeat.js';
import type { ActionRequest, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助：构造最小化 WorldStateView
// ──────────────────────────────────────────────────────────────────

function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: null,
    inventory: { items: [], held: null, freeSlots: 36 },
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    entities: [],
    taskContext: null,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// 辅助：构造 ActionRequest
// ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<ActionRequest>): ActionRequest {
  return {
    id: 'test-req',
    source: 'test',
    type: 'say',
    priority: 50,
    interrupt_level: 'soft',
    resource: [],
    preconditions: [],
    timeout_ms: 500,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('ActionArbitrator', () => {
  const arb = new ActionArbitrator();
  const world = makeWorld();

  // ① 单请求无资源 → 通过成为 winner
  it('① 单请求无资源 → 通过成为 winner', () => {
    const req = makeReq({ id: 'r1', type: 'say', resource: [] });
    const result = arb.arbitrate([req], world, false, null);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].id, 'r1');
    assert.equal(result.rejected.length, 0);
  });

  // ② 多请求按优先级排序（高优先级优先）
  it('② 多请求按优先级排序，高优先级在前', () => {
    const low = makeReq({ id: 'low', type: 'say', priority: 20, resource: [] });
    const high = makeReq({ id: 'high', type: 'stop', priority: 80, resource: [] });
    const mid = makeReq({ id: 'mid', type: 'say', priority: 50, resource: [] });
    const result = arb.arbitrate([low, mid, high], world, false, null);
    // 所有无资源冲突的请求都通过，但顺序按优先级降序
    assert.equal(result.winners.length, 3);
    assert.equal(result.winners[0].id, 'high');
    assert.equal(result.winners[1].id, 'mid');
    assert.equal(result.winners[2].id, 'low');
  });

  // ③ 资源冲突：两个请求都占 movement → 高优先级赢，低优先级被拒 resource_conflict
  it('③ 资源冲突：movement 冲突 → 高优先级赢，低优先级拒绝 resource_conflict', () => {
    const high = makeReq({
      id: 'move-high',
      type: 'move_to',
      priority: 70,
      resource: ['movement'],
    });
    const low = makeReq({
      id: 'move-low',
      type: 'follow_entity',
      priority: 30,
      resource: ['movement'],
    });
    const result = arb.arbitrate([high, low], world, false, null);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].id, 'move-high');
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].request.id, 'move-low');
    assert.equal(result.rejected[0].reason, 'resource_conflict');
  });

  // ④ 多胜出：movement + say（无资源）→ 同 tick 并行通过
  it('④ 多胜出：movement 请求 + say 无资源 → 两者同时胜出', () => {
    const mover = makeReq({
      id: 'mover',
      type: 'move_to',
      priority: 60,
      resource: ['movement'],
    });
    const sayer = makeReq({
      id: 'sayer',
      type: 'say',
      priority: 40,
      resource: [],
    });
    const result = arb.arbitrate([mover, sayer], world, false, null);
    assert.equal(result.winners.length, 2);
    const winnerIds = result.winners.map(w => w.id);
    assert.ok(winnerIds.includes('mover'));
    assert.ok(winnerIds.includes('sayer'));
    assert.equal(result.rejected.length, 0);
  });

  // ⑤ 硬抢占：executing=true，新请求 interrupt_level=hard + 更高优先级 → 赢
  it('⑤ 硬抢占：hard + 更高优先级 → winner', () => {
    const current = makeReq({
      id: 'current',
      type: 'move_to',
      priority: 40,
      resource: ['movement'],
    });
    const intruder = makeReq({
      id: 'hard-intruder',
      type: 'attack',
      priority: 90,
      interrupt_level: 'hard',
      resource: ['movement'],
    });
    const result = arb.arbitrate([intruder], world, true, current);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].id, 'hard-intruder');
  });

  // ⑥ 软不抢：executing=true，interrupt_level=soft，有资源 → rejected busy:...
  it('⑥ 软不抢：soft + 有资源 + executing → rejected busy:...', () => {
    const current = makeReq({
      id: 'current',
      source: 'follow_strategy',
      type: 'move_to',
      priority: 40,
      resource: ['movement'],
    });
    const challenger = makeReq({
      id: 'challenger',
      type: 'move_to',
      priority: 60,
      interrupt_level: 'soft',
      resource: ['movement'],
    });
    const result = arb.arbitrate([challenger], world, true, current);
    assert.equal(result.winners.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.startsWith('busy:'));
  });

  // ⑦ 前置条件 owner_visible 不满足 → rejected precondition_missing:owner_visible
  it('⑦ 前置条件 owner_visible 不满足 → rejected precondition_missing:owner_visible', () => {
    // owner is null → owner_visible fails
    const req = makeReq({
      id: 'need-owner',
      type: 'follow_entity',
      preconditions: ['owner_visible'],
      resource: ['movement'],
    });
    const result = arb.arbitrate([req], makeWorld({ owner: null }), false, null);
    assert.equal(result.winners.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, 'precondition_missing:owner_visible');
  });

  // ⑧ 轻动作 say 在 executing=true 时仍可通过（resource=[]，不抢游戏主控）
  it('⑧ 轻动作 say 在 executing=true 时仍可通过', () => {
    const current = makeReq({
      id: 'current',
      source: 'follow_strategy',
      type: 'move_to',
      priority: 40,
      resource: ['movement'],
    });
    const sayReq = makeReq({
      id: 'say-while-moving',
      type: 'say',
      priority: 50,
      interrupt_level: 'soft',
      resource: [],
    });
    const result = arb.arbitrate([sayReq], world, true, current);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].id, 'say-while-moving');
    assert.equal(result.rejected.length, 0);
  });
});
