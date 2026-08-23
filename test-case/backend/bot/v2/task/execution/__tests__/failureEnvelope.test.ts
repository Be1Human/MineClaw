import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { failureFromLegacy } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/failureEnvelope.js';

describe('BUG-CROSS-47 · FailureEnvelope legacy boundary', () => {
  test('wording variants map to stable contract semantics', () => {
    const variants = [
      'place_block requires target.itemName',
      'invalid parameter: target.itemName',
      'missing parameter itemName',
    ];
    for (const detail of variants) {
      const failure = failureFromLegacy(detail);
      assert.equal(failure.code, 'contract.invalid_parameter');
      assert.equal(failure.category, 'contract');
      assert.equal(failure.origin, 'contract');
    }
  });

  test('navigation, resource, precondition, timeout and fatal failures are separated', () => {
    assert.equal(failureFromLegacy('nav_timeout after 30s').category, 'navigation');
    assert.equal(failureFromLegacy('no_block_nearby:iron_ore').category, 'resource');
    assert.equal(failureFromLegacy('smelt_need_furnace').category, 'precondition');
    assert.equal(failureFromLegacy('operation timed out').category, 'timeout');
    assert.equal(failureFromLegacy('died').category, 'fatal');
  });

  test('an existing envelope passes through without text reclassification', () => {
    const original = {
      code: 'environment.raining',
      origin: 'environment' as const,
      stage: 'executing' as const,
      category: 'environment' as const,
      retryable: true,
      ownerActionable: false,
      evidenceRefs: ['fact-1'],
      detail: 'rain',
    };
    assert.equal(failureFromLegacy(original), original);
  });
});
