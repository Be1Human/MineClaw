import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultAtomicContractRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/atomic/contracts/defaultContracts.js';
import type { ExecutionResult } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { ActionPreparer } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/actionPreparer.js';

function result(ok: boolean): ExecutionResult {
  return {
    ok,
    request: {
      id: 'execution-contract-test',
      source: 'test',
      type: 'invoke_behavior',
      priority: 35,
      interrupt_level: 'soft',
      resource: [],
      target: { behavior: 'gather_block' },
      preconditions: [],
      timeout_ms: 30_000,
    },
    durationMs: 1,
    ...(ok ? {} : { error: 'behavior failed' }),
  };
}

test('registered action success remains a null failure after normalization', () => {
  const preparer = new ActionPreparer(createDefaultAtomicContractRegistry());
  assert.equal(preparer.normalize('invoke_behavior', result(true)), null);
});

test('only an unregistered action normalizes to contract.unknown_action', () => {
  const preparer = new ActionPreparer(createDefaultAtomicContractRegistry());
  const failure = preparer.normalize('invented_action', result(true));
  assert.equal(failure?.code, 'contract.unknown_action');
  assert.match(failure?.detail ?? '', /invented_action/);
});
