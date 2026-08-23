import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Bot } from 'mineflayer';
import { MineflayerGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';

class FakeBot extends EventEmitter {
  username = 'LanYi';
  health = 20;
  food = 20;
}

test('TC-L1-05: every GameAdapter subscription migrates to the replacement Bot', () => {
  const first = new FakeBot();
  const second = new FakeBot();
  let current = first as unknown as Bot;
  const adapter = new MineflayerGameAdapter(() => current);
  const seen: string[] = [];

  adapter.onChat((sender, message) => seen.push(`chat:${sender}:${message}`));
  adapter.onWhisper((sender, message) => seen.push(`whisper:${sender}:${message}`));
  adapter.onHealthChange(({ health, food }) => seen.push(`health:${health}:${food}`));
  adapter.onDeath(() => seen.push('death'));
  adapter.onSpawn(() => seen.push('spawn'));

  current = second as unknown as Bot;
  adapter.rebindSubscriptions(current);

  first.emit('chat', 'owner', 'old');
  first.emit('whisper', 'owner', 'old');
  first.emit('health');
  first.emit('death');
  first.emit('spawn');
  assert.deepEqual(seen, []);

  second.health = 17;
  second.food = 15;
  second.emit('chat', 'owner', 'new');
  second.emit('whisper', 'owner', 'new');
  second.emit('health');
  second.emit('death');
  second.emit('spawn');
  assert.deepEqual(seen, [
    'chat:owner:new',
    'whisper:owner:new',
    'health:17:15',
    'death',
    'spawn',
  ]);
});

test('TC-L1-06: cancelled subscription stays cancelled after later Bot replacements', () => {
  const first = new FakeBot();
  const second = new FakeBot();
  let current = first as unknown as Bot;
  const adapter = new MineflayerGameAdapter(() => current);
  let calls = 0;

  const unsubscribe = adapter.onChat(() => calls++);
  unsubscribe();
  current = second as unknown as Bot;
  adapter.rebindSubscriptions(current);
  first.emit('chat', 'owner', 'old');
  second.emit('chat', 'owner', 'new');
  assert.equal(calls, 0);
});

test('BUG-CROSS-69: dropped item identity is preserved by the adapter', () => {
  const entity = {
    id: 41,
    name: 'item',
    type: 'object',
    position: { x: 5, y: 64, z: 0 },
    getDroppedItem: () => ({ name: 'iron_pickaxe', count: 1 }),
  };
  const bot = { entities: { 41: entity } } as unknown as Bot;
  const adapter = new MineflayerGameAdapter(() => bot);

  assert.deepEqual(adapter.getEntities(), [{
    id: 41,
    name: 'item',
    type: 'object',
    position: { x: 5, y: 64, z: 0 },
    velocity: undefined,
    yaw: undefined,
    pitch: undefined,
    health: undefined,
    username: undefined,
    droppedItem: { name: 'iron_pickaxe', count: 1 },
  }]);
});
