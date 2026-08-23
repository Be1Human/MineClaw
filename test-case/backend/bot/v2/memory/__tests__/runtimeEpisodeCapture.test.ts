import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { EpisodeAssembler, EpisodeStore, RuntimeEpisodeCapture } from '../../../../../../apps/minecraft-companion/src/bot/v2/memory/index.js';

describe('RuntimeEpisodeCapture', () => {
  test('runtime under_attack → atomic.attack → danger_cleared persists a queryable combat episode', () => {
    const bus = new EventBusV2();
    const store = new EpisodeStore(':memory:');
    let world = makeWorld(14, ['zombie']);
    const capture = new RuntimeEpisodeCapture({
      profileId: 'profile-a',
      ownerName: 'owner',
      botName: 'LanYi',
      bus,
      assembler: new EpisodeAssembler(store),
      world: () => world,
    });

    bus.publish('under_attack', 'critical', { prevHealth: 20, currHealth: 14, damage: 6 });
    bus.publish('atomic.attack', 'info', { entityId: 7, target: 'zombie' });
    world = makeWorld(12, []);
    bus.publish('danger_cleared', 'info', { reason: 'no_hostiles' });

    const episodes = store.query({ profileId: 'profile-a', kind: 'combat' });
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.state, 'finalized');
    assert.equal(episodes[0]?.outcome, 'survived');
    assert.equal(episodes[0]?.keyEvents.some(item => item.includes('受到攻击')), true);
    assert.equal(episodes[0]?.keyEvents.some(item => item.includes('反击')), true);
    assert.equal(episodes[0]?.participants.some(item => item.id === 'zombie:7'), true);
    assert.equal(episodes[0]?.sourceRefs.length, 3);

    capture.stop();
    store.close();
  });

  test('task lifecycle and combat remain separate episodes', () => {
    const bus = new EventBusV2();
    const store = new EpisodeStore(':memory:');
    const capture = new RuntimeEpisodeCapture({
      profileId: 'profile-a', ownerName: 'owner', botName: 'LanYi', bus,
      assembler: new EpisodeAssembler(store), world: () => makeWorld(18, ['creeper']),
    });
    bus.publish('task.started', 'info', { taskId: 'task-1', kind: 'follow_owner' });
    bus.publish('under_attack', 'recoverable', { prevHealth: 20, currHealth: 18, damage: 2 });
    bus.publish('danger_cleared', 'info', {});
    bus.publish('task.completed', 'info', { taskId: 'task-1', kind: 'follow_owner' });

    assert.equal(store.query({ profileId: 'profile-a', kind: 'task' }).length, 1);
    assert.equal(store.query({ profileId: 'profile-a', kind: 'combat' }).length, 1);
    assert.equal(store.count('profile-a'), 2);
    capture.stop();
    store.close();
  });
});

function makeWorld(health: number, hostiles: string[]): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: { position: { x: 10, y: 64, z: 20 }, yaw: 0, pitch: 0, health, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'owner', position: { x: 12, y: 64, z: 20 }, distance: 2, entityId: 1, isVisible: true },
    environment: { dimension: 'overworld', timeOfDay: 13_000, isDay: false, isRaining: false },
    entities: hostiles.map((name, index) => ({
      id: 7 + index, name, type: 'mob', position: { x: 15 + index, y: 64, z: 20 }, distance: 5 + index, category: 'hostile' as const,
    })),
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: { currentTaskId: 'task-1', currentTaskKind: 'follow_owner', currentTaskState: 'running' },
  };
}
