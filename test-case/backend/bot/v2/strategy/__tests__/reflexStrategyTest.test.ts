import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ReflexStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/reflexStrategy.js';

describe('ReflexStrategy has no legacy behavior dispatch', () => {
  it('event callback is inert and never returns a raw behavior request', () => {
    const reflex = new ReflexStrategy();
    const result = reflex.onEvent(
      { id: 'attack', type: 'under_attack', level: 'critical', timestamp: 1, payload: {} },
      {} as never,
    );
    assert.deepEqual(result, []);
  });

  it('suspend only preserves the retired no-op contract', () => {
    const reflex = new ReflexStrategy();
    reflex.suspend();
    assert.equal(reflex.inspect().kind, 'reflex');
  });
});
