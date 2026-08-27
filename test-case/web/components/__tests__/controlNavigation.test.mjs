import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_TAB_IDS,
  migrateControlTabs,
  normalizeControlTab,
} from '../../../../apps/minecraft-companion/web/src/lib/controlNavigation.js';

test('控制标签只暴露互动技术页和三个辅助页', () => {
  assert.deepEqual(CONTROL_TAB_IDS, ['status', 'tasks', 'inventory', 'logs']);
  assert.equal(normalizeControlTab('status'), 'status');
  assert.equal(normalizeControlTab('chat'), 'status');
  assert.equal(normalizeControlTab('unknown'), null);
});

test('旧 chat 持久化值迁入 status 且不影响其他伙伴', () => {
  const result = migrateControlTabs({ a: 'chat', b: 'status', c: 'tasks', d: 'unknown' });
  assert.equal(result.changed, true);
  assert.deepEqual(result.controlTabs, { a: 'status', b: 'status', c: 'tasks' });

  const unchanged = migrateControlTabs({ a: 'status', b: 'inventory', c: 'logs' });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.controlTabs, { a: 'status', b: 'inventory', c: 'logs' });
});
