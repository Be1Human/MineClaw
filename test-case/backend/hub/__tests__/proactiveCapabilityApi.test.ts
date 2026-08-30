import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

test('FEAT-CROSS-25 · proactive catalog API hot-applies through runtime and persists generic preferences', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-proactive-api-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    const profile = hub.profileStore.create({
      name: 'ProactiveTest', ownerUsername: 'Steve',
      server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
    });
    const snapshot = {
      catalog: [{
        packageId: 'third.party', id: 'third_party_patrol', label: '第三方巡逻', description: 'test',
        goalTarget: 'minecraft:test', defaultEnabled: false, enabled: true, rate: 'slow', priority: 1,
        decisionMode: 'deterministic', conflictGroups: [], configSchema: {}, config: {},
      }],
      states: [{ id: 'third_party_patrol', enabled: true, state: 'idle' }],
      lease: { active: null, releasing: null },
    };
    let hotApplied: unknown = null;
    (hub.botManager as any).getProactiveRuntimeSnapshot = () => snapshot;
    (hub.botManager as any).setProactiveCapabilityPreferences = (_botId: string, value: unknown) => {
      hotApplied = structuredClone(value);
      const enabled = Boolean((value as any)?.third_party_patrol?.enabled);
      snapshot.catalog[0]!.enabled = enabled;
      snapshot.states[0]!.enabled = enabled;
      snapshot.states[0]!.state = enabled ? 'idle' : 'disabled';
      return snapshot;
    };

    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const catalog = await fetch(`${origin}/api/bots/${profile.id}/proactive-capabilities`);
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json() as any).catalog[0].id, 'third_party_patrol');

    const controls = await fetch(`${origin}/api/bots/${profile.id}/capabilities`);
    assert.equal(controls.status, 200);
    const controlSnapshot = await controls.json() as any;
    assert.equal(controlSnapshot.capabilities.find((entry: any) => entry.id === 'service:memory_consolidation').enabled, true);
    const proactiveControl = controlSnapshot.capabilities.find((entry: any) => entry.id === 'proactive:third_party_patrol');
    assert.equal(proactiveControl.control.method, 'PATCH');

    const quickToggle = await fetch(`${origin}${proactiveControl.control.href}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(quickToggle.status, 200);
    assert.deepEqual(hotApplied, { third_party_patrol: { enabled: false } });
    assert.equal((await quickToggle.json() as any).capabilities.find((entry: any) => entry.id === 'proactive:third_party_patrol').enabled, false);

    const memoryToggle = await fetch(`${origin}/api/bots/${profile.id}/capabilities/service%3Amemory_consolidation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(memoryToggle.status, 200);
    assert.equal(hub.profileStore.get(profile.id)?.memory?.consolidationEnabled, false);
    assert.equal((await memoryToggle.json() as any).capabilities.find((entry: any) => entry.id === 'service:memory_consolidation').enabled, false);

    const readOnly = await fetch(`${origin}/api/bots/${profile.id}/capabilities/base%3Achat`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(readOnly.status, 409);
    const invalidQuickToggle = await fetch(`${origin}${proactiveControl.control.href}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(invalidQuickToggle.status, 400);

    const response = await fetch(`${origin}/api/bots/${profile.id}/proactive-capabilities`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { third_party_patrol: { enabled: true } } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(hotApplied, { third_party_patrol: { enabled: true } });
    assert.deepEqual(
      hub.profileStore.getCharacterCard(profile.id)?.performance.proactiveCapabilities,
      { third_party_patrol: { enabled: true } },
    );

    const invalid = await fetch(`${origin}/api/bots/${profile.id}/proactive-capabilities`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capabilities: [] }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
