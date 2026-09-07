import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionResult } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { ActionPreparer } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/actionPreparer.js';
import { buildSystemAtomicContracts } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/atomicContracts.js';
import type { GenerationContractResolverPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/generationResolversPorts.js';

const snapshot = { generationId: 'test-generation', buildId: 'test-build', graphHash: 'test-graph' };
const contracts = buildSystemAtomicContracts(['say']);
const resolver: GenerationContractResolverPort = {
  resolve: (_snapshot, action) => {
    const contract = contracts.find(value => value.atomicId === action);
    return contract ? { status: 'resolved', value: contract } : { status: 'in_doubt', reason: `atomic_not_in_generation:${action}` };
  },
  list: () => ({ status: 'resolved', value: contracts }),
};

function result(ok: boolean): ExecutionResult {
  return {
    ok,
    request: {
      id: 'execution-contract-test',
      source: 'test',
      type: 'say',
      priority: 35,
      interrupt_level: 'soft',
      resource: [],
      target: { text: 'hello' },
      preconditions: [],
      timeout_ms: 30_000,
    },
    durationMs: 1,
    ...(ok ? {} : { error: 'behavior failed' }),
  };
}

test('registered action success remains a null failure after normalization', () => {
  const preparer = new ActionPreparer(resolver);
  assert.equal(preparer.normalize(snapshot, 'say', result(true)), null);
});

test('only an unregistered action normalizes to contract.unknown_action', () => {
  const preparer = new ActionPreparer(resolver);
  const failure = preparer.normalize(snapshot, 'invented_action', result(true));
  assert.equal(failure?.code, 'contract.unknown_action');
  assert.match(failure?.detail ?? '', /invented_action/);
});
