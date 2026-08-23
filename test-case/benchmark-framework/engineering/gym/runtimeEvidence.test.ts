import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { filterRuntimeLogForProfile, resolveRuntimeLogDir } from '../../../../benchmark/engineering/experience/runtimeEvidence.js';

test('BUG-CROSS-33 | Gym 日志目录优先跟随 GYM_DATA_DIR', () => {
  const appDir = path.resolve('D:/repo/apps/minecraft-companion');
  assert.equal(
    resolveRuntimeLogDir(appDir, { GYM_DATA_DIR: 'data-gym', DATA_DIR: 'data-beta' }),
    path.join(appDir, 'data-gym', 'logs'),
  );
  assert.equal(
    resolveRuntimeLogDir(appDir, { DATA_DIR: 'custom-data' }),
    path.join(appDir, 'custom-data', 'logs'),
  );
  assert.equal(
    resolveRuntimeLogDir(appDir, {}),
    path.join(appDir, 'data', 'logs'),
  );
});

test('BUG-CROSS-33 | Runtime 证据只保留被测 Profile', () => {
  const gymId = 'gym-profile';
  const betaId = 'beta-profile';
  const mixed = [
    `2026-07-26 [info] [${betaId}] Beta restarted`,
    `2026-07-26 [info] [${gymId}] task started`,
    '2026-07-26 [info] global server line',
    `2026-07-26 [warn] [${gymId}] path retry`,
  ].join('\r\n');
  const filtered = filterRuntimeLogForProfile(mixed, gymId);
  assert.match(filtered, /task started/);
  assert.match(filtered, /path retry/);
  assert.doesNotMatch(filtered, /Beta restarted|global server line|beta-profile/);
  assert.equal(filterRuntimeLogForProfile(mixed, 'missing-profile'), '');
});
