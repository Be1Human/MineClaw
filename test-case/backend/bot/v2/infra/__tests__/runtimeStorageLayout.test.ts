import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';

import { RuntimeStorageLayout } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/runtimeStorageLayout.js';

test('F09 · in-memory Runtime storage uses independent SQLite stores and an owned temporary directory', () => {
  const first = new RuntimeStorageLayout(':memory:');
  const second = new RuntimeStorageLayout(':memory:');
  try {
    assert.equal(first.database('goal-agent-actions-MineFriend.db'), ':memory:');
    assert.equal(second.database('goal-agent-actions-MineFriend.db'), ':memory:');
    assert.equal(first.database('world_map.db'), ':memory:');
    assert.notEqual(first.directory('runs'), second.directory('runs'));

    mkdirSync(first.directory('runs'), { recursive: true });
    mkdirSync(second.directory('runs'), { recursive: true });
    writeFileSync(join(first.directory('runs'), 'probe.txt'), 'first', { encoding: 'utf8' });
    writeFileSync(join(second.directory('runs'), 'probe.txt'), 'second', { encoding: 'utf8' });
    assert.equal(existsSync(join(first.directory('runs'), 'probe.txt')), true);
    assert.equal(existsSync(join(second.directory('runs'), 'probe.txt')), true);
  } finally {
    const firstRoot = dirname(first.directory('runs'));
    const secondRoot = dirname(second.directory('runs'));
    first.dispose();
    second.dispose();
    assert.equal(existsSync(firstRoot), false);
    assert.equal(existsSync(secondRoot), false);
  }
});

test('F09 · persistent Runtime storage preserves the primary database directory and explicit names', () => {
  const layout = new RuntimeStorageLayout('data/profile/v2-memory.db');
  try {
    assert.equal(layout.database('goal-agent-actions-LanYi.db'), join('data', 'profile', 'goal-agent-actions-LanYi.db'));
    assert.equal(layout.database('world_map.db'), join('data', 'profile', 'world_map.db'));
    assert.equal(layout.directory('strategies'), join('data', 'profile', 'strategies'));
  } finally {
    layout.dispose();
  }
});
