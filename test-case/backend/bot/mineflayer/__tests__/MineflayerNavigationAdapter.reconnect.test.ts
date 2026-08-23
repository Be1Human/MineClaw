import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Bot } from 'mineflayer';
import { MineflayerNavigationAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerNavigationAdapter.js';

class FakeBot extends EventEmitter {}

test('navigation subscriptions migrate with the replacement Bot', () => {
  const first = new FakeBot();
  const second = new FakeBot();
  let current = first as unknown as Bot;
  const adapter = new MineflayerNavigationAdapter(() => current);
  const seen: string[] = [];

  adapter.onGoalReached(() => seen.push('goal_reached'));
  adapter.onPathUpdate(path => seen.push(`path:${path.length}`));
  adapter.onPathStop(reason => seen.push(`stop:${reason}`));
  adapter.onGoalUpdated(() => seen.push('goal_updated'));

  current = second as unknown as Bot;
  adapter.rebindSubscriptions(current);
  first.emit('goal_reached');
  first.emit('path_update', { path: [{ x: 1, y: 2, z: 3 }] });
  assert.deepEqual(seen, []);

  second.emit('goal_reached');
  second.emit('path_update', { path: [{ x: 1, y: 2, z: 3 }] });
  second.emit('path_stop', 'done');
  second.emit('goal_updated');
  assert.deepEqual(seen, ['goal_reached', 'path:1', 'stop:done', 'goal_updated']);
});
