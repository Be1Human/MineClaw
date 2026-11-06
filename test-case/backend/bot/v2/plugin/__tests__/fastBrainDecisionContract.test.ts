import test from 'node:test';
import assert from 'node:assert/strict';
import { fastBrainDecisionCatalog, parseFastBrainDecision } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/decisionContract.js';

const inputs = {
  observe: {}, search: { kind: 'oak_log', radius: 5 }, explore: { frontier_id: 'f1', radius: 5 },
  move_to: { target_id: 't1' }, mine: { target_id: 't1' }, pickup: { target_id: 'd1' },
  place: { item: 'crafting_table', position: { x: 1, y: 64, z: 0 } },
  craft: { recipe: 'stone_pickaxe', count: 1, station_id: 't1' },
  smelt: { station_id: 'f1', input: 'raw_iron', count: 1, fuel: 'coal' },
  collect_output: { station_id: 'f1', job_id: 'j1' }, equip: { item: 'shield', slot: 'off-hand' },
  attack: { target_id: 'e1' }, retreat: { target_id: 'n1' }, consume: { item: 'bread' },
  wait: { request_id: 'r1', max_ticks: 10 }, cancel: { request_id: 'r1' },
};
for (const [skill, args] of Object.entries(inputs)) {
  test(skill + ': accepts example; rejects host-owned data', () => {
    const call = { type: 'call', skill, args };
    assert.deepEqual(parseFastBrainDecision(call), call);
    assert.throws(() => parseFastBrainDecision({ ...call, args: { ...args, budget: 123 } }));
    assert.throws(() => parseFastBrainDecision({ ...call, request_id: 'spoofed' }));
  });
}
test('terminal decisions are not callable body skills', () => {
  assert.deepEqual(parseFastBrainDecision({ type: 'finish' }), { type: 'finish' });
  const blocked = { type: 'report_blocked', reason: 'missing_material' };
  assert.deepEqual(parseFastBrainDecision(blocked), blocked);
  assert.throws(() => parseFastBrainDecision({ type: 'call', skill: 'finish', args: {} }));
  assert.throws(() => parseFastBrainDecision({ type: 'report_blocked' }));
});
test('catalog has exactly the negotiated names and returns isolated snapshots', () => {
  const first = fastBrainDecisionCatalog();
  assert.deepEqual(first.map(x => x.name).sort(), [...Object.keys(inputs), 'finish', 'report_blocked'].sort());
  first[0].schema.required = [];
  assert.notDeepEqual(first, fastBrainDecisionCatalog());
});
test('wait selectors cannot conflict, quantities must be positive, coordinates integral', () => {
  for (const [skill, args] of [
    ['wait', { request_id: 'r1', job_id: 'j1', max_ticks: 2 }],
    ['craft', { recipe: 'x', count: 0 }],
    ['place', { item: 'x', position: { x: 0.5, y: 0, z: 0 } }],
    ['give', {}],
  ]) assert.throws(() => parseFastBrainDecision({ type: 'call', skill, args }));
});
