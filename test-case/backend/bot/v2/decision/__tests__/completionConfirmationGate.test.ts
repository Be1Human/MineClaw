import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmCompletion } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/completionConfirmationGate.js';
import type { GoalSuccessCriterion } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function world(inventory: Array<{ name: string; count: number }> = []): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: {} as WorldStateView['environment'],
    entities: [],
    inventory: { items: inventory, held: null, freeSlots: 36 },
    taskContext: null,
  };
}

test('T1 · deliver 无收据 → 拒绝 deliver_missing_receipt', () => {
  const verdict = confirmCompletion({
    goalText: '给我一把石斧',
    criteria: [{ type: 'item_delivered', item: 'stone_axe', count: 1, since: 100 }],
    world: world(),
    evidence: { deliveries: [] },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'deliver_missing_receipt');
});

test('T2 · deliver 有匹配收据 → 确认', () => {
  const verdict = confirmCompletion({
    goalText: '给我一把石斧',
    criteria: [{ type: 'item_delivered', item: 'stone_axe', count: 1, since: 100 }],
    world: world(),
    evidence: { deliveries: [{ item: 'stone_axe', count: 1, at: 150, ref: 'toss-1' }] },
  });
  assert.equal(verdict.ok, true);
});

test('T3 · deliver 收据时间早于 since → 拒绝（历史收据不算）', () => {
  const verdict = confirmCompletion({
    goalText: '给我一把石斧',
    criteria: [{ type: 'item_delivered', item: 'stone_axe', count: 1, since: 100 }],
    world: world(),
    evidence: { deliveries: [{ item: 'stone_axe', count: 1, at: 50, ref: 'toss-old' }] },
  });
  assert.equal(verdict.ok, false);
});

test('T4 · deliver 数量不足 → 拒绝', () => {
  const verdict = confirmCompletion({
    goalText: '给我两个石斧',
    criteria: [{ type: 'item_delivered', item: 'stone_axe', count: 2, since: 100 }],
    world: world(),
    evidence: { deliveries: [{ item: 'stone_axe', count: 1, at: 150, ref: 'toss-1' }] },
  });
  assert.equal(verdict.ok, false);
});

test('T5 · place 缺 placement 收据 → 拒绝 place_missing_receipt', () => {
  const verdict = confirmCompletion({
    goalText: '把工作台放在主人旁边',
    criteria: [{ type: 'block_placed', item: 'crafting_table', count: 1, since: 100, relativeTo: 'owner', relation: 'near', radius: 1.5 }],
    world: world(),
    evidence: { placements: [] },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'place_missing_receipt');
});

test('T6 · place 有匹配收据（相对关系+时间锚）→ 确认', () => {
  const verdict = confirmCompletion({
    goalText: '把工作台放在主人旁边',
    criteria: [{ type: 'block_placed', item: 'crafting_table', count: 1, since: 100, relativeTo: 'owner', relation: 'near', radius: 1.5 }],
    world: world(),
    evidence: {
      placements: [{
        item: 'crafting_table', count: 1, at: 150,
        position: { x: 0, y: 64, z: 0 },
        relativeTo: 'owner', referencePosition: { x: 0, y: 64, z: 0 }, relation: 'near', ref: 'place-1',
      }],
    },
  });
  assert.equal(verdict.ok, true);
});

test('T7 · obtain fresh 背包不满足 → 拒绝 obtain_inventory_not_satisfied', () => {
  const verdict = confirmCompletion({
    goalText: '获得三块圆石',
    criteria: [{ type: 'inventory', item: 'cobblestone', count: 3 }],
    world: world([{ name: 'dirt', count: 2 }]),
    evidence: {},
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'obtain_inventory_not_satisfied');
});

test('T8 · obtain fresh 背包满足 → 确认', () => {
  const verdict = confirmCompletion({
    goalText: '获得三块圆石',
    criteria: [{ type: 'inventory', item: 'cobblestone', count: 3 }],
    world: world([{ name: 'cobblestone', count: 3 }]),
    evidence: {},
  });
  assert.equal(verdict.ok, true);
});

test('T9 · 无 world 快照 → 拒绝 criteria_invalid（无法复核）', () => {
  const verdict = confirmCompletion({
    goalText: '获得圆石',
    criteria: [{ type: 'inventory', item: 'cobblestone', count: 1 }],
    world: null,
    evidence: {},
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'criteria_invalid');
});

test('T10 · 多判据任一失败 → 拒绝且 reason 取首个失败类型', () => {
  const criteria: GoalSuccessCriterion[] = [
    { type: 'inventory', item: 'cobblestone', count: 3 },
    { type: 'item_delivered', item: 'stone_axe', count: 1, since: 100 },
  ];
  const verdict = confirmCompletion({
    goalText: '采集圆石并给我石斧',
    criteria,
    world: world([{ name: 'cobblestone', count: 3 }]),
    evidence: { deliveries: [] },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'deliver_missing_receipt');
});
