import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HazardDecisionService } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/hazardDecisionService.js';

const service = new HazardDecisionService();

describe('HazardDecisionService', () => {
  it('returns none when no hostile exists and no Activity declares ownership', () => {
    assert.deepEqual(service.decide({ entities: [] }, () => false), { kind: 'none', category: 'hostile' });
  });

  it('returns fallback for hostile evidence without a declaration', () => {
    assert.deepEqual(service.decide({ entities: [{ category: 'hostile' }] } as never, () => false), {
      kind: 'fallback',
      category: 'hostile',
    });
  });

  it('keeps a declared running Activity managed even during its calm recovery window', () => {
    assert.deepEqual(service.decide({ entities: [] }, category => category === 'hostile'), {
      kind: 'managed',
      category: 'hostile',
    });
  });
});
