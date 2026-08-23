import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { goalContractV1, legacyGoalFromContract } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContract.js';
import { parseExecutionFactV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/executionFactsV1.js';
import { EXECUTION_FACT_V1_GOLDEN } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/fixtures/executionFactV1.js';

describe('cross-loop V1 contracts', () => {
  test('legacy Goal round-trips through the frozen shared contract', () => {
    const contract = goalContractV1({
      goalText: 'craft an iron pickaxe',
      successCriteria: [{ type: 'inventory', item: 'iron_pickaxe', count: 1 }],
      constraints: 'do not discard owner items',
    }, { goalId: 'goal-1', profileId: 'profile-1', createdAt: '2026-08-02T12:00:00.000Z' });
    assert.equal(contract.schema, 'mineclaw.goal/v1');
    assert.deepEqual(legacyGoalFromContract(contract).successCriteria, [
      { type: 'inventory', item: 'iron_pickaxe', count: 1 },
    ]);
    assert.equal(legacyGoalFromContract(contract).constraints, 'do not discard owner items');
  });

  test('provider golden fact is accepted by the consumer parser', () => {
    const parsed = parseExecutionFactV1(EXECUTION_FACT_V1_GOLDEN);
    assert.equal(parsed.kind, 'valid');
    if (parsed.kind === 'valid') assert.equal(parsed.knownEventType, true);
  });
});
