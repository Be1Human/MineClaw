import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ReflexStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/reflexStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function ctx(): StrategyContext {
  const world: WorldStateView = {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
  return { world, tick: 1, activeTaskId: 'task-live', activeTaskKind: 'follow_owner' };
}

describe('ReflexStrategy retirement contract', () => {
  it('under_attack ingestion cannot create an independent action path', () => {
    const reflex = new ReflexStrategy({ legacyTaskRuntime: true });
    reflex.ingestCritical([{ id: 'under-attack', type: 'under_attack', level: 'critical', timestamp: 1, payload: {} }]);

    assert.equal(reflex.isActive(ctx()), false);
    assert.deepEqual(reflex.tick(ctx()), []);
  });

  it('inspection advertises the hazard-decision replacement', () => {
    const view = new ReflexStrategy().inspect();
    assert.deepEqual(view, { kind: 'reflex', view: { retired: true, route: 'hazard_decision_service' } });
  });
});
