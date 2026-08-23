import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopPetConfigStore, validateDesktopPetConfig } from '../../../../apps/minecraft-companion/src/hub/desktopPetConfigStore.js';

test('desktop pet config defaults to disabled fixed mode', () => {
  const store = new DesktopPetConfigStore(mkdtempSync(join(tmpdir(), 'desktop-pet-')));
  assert.deepEqual(store.get(), { enabled: false, mode: 'fixed', updatedAt: 0 });
});

test('desktop pet config persists selected role and position', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-pet-'));
  const store = new DesktopPetConfigStore(dir);
  store.update({ enabled: true, profileId: 'role-1', mode: 'wander', position: { displayId: '1', xRatio: 0.25, yRatio: 0.8 } });
  const loaded = new DesktopPetConfigStore(dir).get();
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.profileId, 'role-1');
  assert.equal(loaded.mode, 'wander');
  assert.deepEqual(loaded.position, { displayId: '1', xRatio: 0.25, yRatio: 0.8 });
});

test('desktop pet config rejects invalid mode and coordinates', () => {
  assert.throws(() => validateDesktopPetConfig({ enabled: true, mode: 'fly' }), /mode/);
  assert.throws(() => validateDesktopPetConfig({ enabled: true, mode: 'fixed', position: { displayId: '1', xRatio: 2, yRatio: 0 } }), /ratios/);
});
