import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveRuntimePersistencePaths } from '../../../../apps/minecraft-companion/src/bot/runtimePersistence.js';

test('BUG-CROSS-33 | Profile 持久化路径全部服从 Hub dataDir', () => {
  const root = join('tmp', 'data-gym');
  const paths = resolveRuntimePersistencePaths(root, 'gym-profile');

  assert.deepEqual(paths, {
    memoryDbPath: join(root, 'v2-memory-gym-profile.db'),
    chatMemoryDbPath: join(root, 'chat-memory-gym-profile.db'),
    worldMapDbPath: join(root, 'world-map-gym-profile.db'),
    plannerEvolutionDbPath: join(root, 'planner-evolution-gym-profile.db'),
    plannerExecutionFactsPath: join(root, 'planner-execution-facts-gym-profile.jsonl'),
    plannerRuntimeDbPath: join(root, 'planner-runtime-gym-profile.db'),
    runsDir: join(root, 'runs', 'gym-profile'),
    strategyDir: join(root, 'strategies', 'gym-profile'),
  });
  for (const value of Object.values(paths)) {
    assert.ok(value.startsWith(root), `${value} 必须留在 ${root}`);
  }
});

test('BUG-CROSS-33 | Profile id 被净化且不同 Profile 不共享文件', () => {
  const a = resolveRuntimePersistencePaths('data-gym', 'gym/profile');
  const b = resolveRuntimePersistencePaths('data-gym', 'beta-profile');

  assert.match(a.memoryDbPath, /gym_profile/);
  assert.match(a.plannerEvolutionDbPath, /gym_profile/);
  assert.match(a.plannerExecutionFactsPath, /gym_profile/);
  assert.match(a.plannerRuntimeDbPath, /gym_profile/);
  assert.notEqual(a.memoryDbPath, b.memoryDbPath);
  assert.notEqual(a.plannerEvolutionDbPath, b.plannerEvolutionDbPath);
  assert.notEqual(a.plannerExecutionFactsPath, b.plannerExecutionFactsPath);
  assert.notEqual(a.plannerRuntimeDbPath, b.plannerRuntimeDbPath);
  assert.notEqual(a.runsDir, b.runsDir);
  assert.notEqual(a.strategyDir, b.strategyDir);
});
