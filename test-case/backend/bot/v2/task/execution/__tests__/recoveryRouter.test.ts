import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryRouter } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/recoveryRouter.js';
import type { FailureEnvelope } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/failureEnvelope.js';

const failure = (overrides: Partial<FailureEnvelope>): FailureEnvelope => ({
  code: 'atomic.failed',
  origin: 'atomic',
  stage: 'executing',
  category: 'transient',
  retryable: true,
  ownerActionable: false,
  evidenceRefs: [],
  ...overrides,
});

describe('BUG-CROSS-47 · RecoveryRouter', () => {
  const router = new RecoveryRouter();

  test('contract and precondition failures stay inside deterministic correction paths', () => {
    assert.equal(router.route({
      failure: failure({ category: 'contract', origin: 'contract' }), attempt: 1, maxAttempt: 2,
    }).kind, 'correct_proposal');
    assert.equal(router.route({
      failure: failure({ category: 'precondition' }), attempt: 1, maxAttempt: 2,
    }).kind, 'satisfy_prerequisite');
  });

  test('retryable physical failure retries before budget and requests graph replan after budget', () => {
    const navigation = failure({ code: 'navigation.failed', origin: 'navigation', category: 'navigation' });
    assert.equal(router.route({ failure: navigation, attempt: 1, maxAttempt: 2 }).kind, 'retry');
    assert.equal(router.route({ failure: navigation, attempt: 2, maxAttempt: 2 }).kind, 'graph_replan_required');
  });

  test('owner pause is only selected for an owner-actionable failure', () => {
    const permission = failure({
      code: 'safety.permission_required',
      origin: 'safety',
      category: 'fatal',
      retryable: false,
      ownerActionable: true,
    });
    assert.equal(router.route({ failure: permission, attempt: 1, maxAttempt: 3 }).kind, 'pause_owner');
  });
});
