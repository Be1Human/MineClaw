import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultAtomicContractRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/atomic/contracts/defaultContracts.js';
import { ActionPreparer } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/actionPreparer.js';

const registry = createDefaultAtomicContractRegistry();
const preparer = new ActionPreparer(registry);

describe('BUG-CROSS-47 · Atomic action contracts', () => {
  test('all currently executable atomic actions have one registered contract', () => {
    assert.equal(registry.list().length, 37);
    for (const action of ['craft', 'smelt', 'place_block', 'move_to', 'dig', 'equip', 'invoke_behavior']) {
      assert.ok(registry.get(action), `missing contract for ${action}`);
    }
  });

  test('missing user intent fails at prepare stage and never creates ActionRequest', () => {
    const result = preparer.prepare(
      { source: 'slow_llm', action: 'place_block', args: {} },
      { execId: 'exec-1', taskId: 'task-1' },
    );
    assert.equal(result.kind, 'invalid');
    if (result.kind !== 'invalid') return;
    assert.equal(result.failure.code, 'contract.missing_parameter');
    assert.equal(result.failure.origin, 'contract');
    assert.equal(result.failure.stage, 'preparing');
    assert.equal(result.failure.category, 'contract');
    assert.equal(result.failure.ownerActionable, false);
  });

  test('deterministic aliases and coordinates are normalized before execution', () => {
    const result = preparer.prepare(
      { source: 'fast_strategy', action: 'place_block', args: { item: 'cobblestone', x: 1, y: 64, z: 2 } },
      { execId: 'exec-2', taskId: 'task-2' },
    );
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.deepEqual(result.action.derivedFields.sort(), ['itemName', 'position']);
    assert.equal(result.request.target?.itemName, 'cobblestone');
    assert.deepEqual(result.request.target?.position, { x: 1, y: 64, z: 2 });
    assert.equal(result.request.source, 'goalagent.fast_strategy');
  });

  test('smelt requires input item only; fuel and furnace remain world-derived atomic facts', () => {
    const result = preparer.prepare(
      { source: 'slow_llm', action: 'smelt', args: { itemName: 'raw_iron', count: 3 } },
      { execId: 'exec-3' },
    );
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.request.target?.itemName, 'raw_iron');
    assert.equal(result.request.target?.fuelName, undefined);
    assert.equal(result.request.target?.tablePos, undefined);
  });

  test('invalid numeric and vector values fail closed', () => {
    const badCount = preparer.prepare(
      { source: 'slow_llm', action: 'craft', args: { itemName: 'stick', count: 0 } },
      { execId: 'exec-4' },
    );
    assert.equal(badCount.kind, 'invalid');

    const badPosition = preparer.prepare(
      { source: 'slow_llm', action: 'dig', args: { position: { x: 1, y: '64', z: 2 } } },
      { execId: 'exec-5' },
    );
    assert.equal(badPosition.kind, 'invalid');

    const partialPosition = preparer.prepare(
      { source: 'slow_llm', action: 'dig', args: { position: { x: 1 } } },
      { execId: 'exec-5b' },
    );
    assert.equal(partialPosition.kind, 'invalid');
  });

  test('schema projection and runtime preparation use the same definition', () => {
    const schema = preparer.schemas().place_block;
    assert.deepEqual(schema?.required, ['itemName']);
    assert.equal(schema?.additionalProperties, false);

    const result = preparer.prepare(
      { source: 'slow_llm', action: 'place_block', args: {} },
      { execId: 'exec-6' },
    );
    assert.equal(result.kind, 'invalid');
  });

  test('unresolved strategy placeholders fail closed before Atomic or Behavior execution', () => {
    for (const placeholder of [
      '{targetPos}', '${targetPos}', '$targetPos', '$positions[0]',
      '${positions[current]}', 'find_adjacent_stone({targetBlock}, {searchRadius})',
    ]) {
      const result = preparer.prepare(
        {
          source: 'fast_strategy',
          action: 'invoke_behavior',
          args: {
            behavior: 'gather_block',
            behaviorParams: { pos: placeholder, blockName: 'oak_log' },
          },
        },
        { execId: `placeholder-${placeholder}` },
      );
      assert.equal(result.kind, 'invalid');
      if (result.kind !== 'invalid') continue;
      assert.equal(result.failure.code, 'contract.unresolved_placeholder');
      assert.match(result.failure.detail ?? '', /behaviorParams\.pos/);
    }
  });
});
