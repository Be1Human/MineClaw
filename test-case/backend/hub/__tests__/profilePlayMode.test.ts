import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import { ProfileStore, toPublicBotProfile } from '../../../../apps/minecraft-companion/src/hub/profileStore.js';

function profileInput(name: string, playMode?: unknown) {
  return {
    name,
    personality: { description: `${name} companion`, style: 'calm' },
    server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
    ...(playMode === undefined ? {} : { playMode }),
  };
}

async function closeHub(hub: ReturnType<typeof createHubServer>): Promise<void> {
  await hub.botManager.stopAll();
  if (hub.httpServer.listening) {
    await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
  }
}

test('FEAT-WEBUI-28 | ProfileStore persists survival and normalizes legacy profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-profile-play-mode-store-'));
  try {
    const profiles = new ProfileStore(dir);
    const created = profiles.create(profileInput('SurvivalFriend'));
    assert.equal(created.playMode, 'survival');
    assert.equal(toPublicBotProfile(created).playMode, 'survival');

    const persisted = JSON.parse(readFileSync(join(dir, 'profiles', `${created.id}.json`), 'utf8')) as { playMode?: string };
    assert.equal(persisted.playMode, 'survival');
    assert.throws(
      () => profiles.create(profileInput('CreativeFriend', 'creative') as never),
      /创造模式暂未开放/,
    );

    const legacyDir = join(dir, 'legacy');
    const legacyProfilesDir = join(legacyDir, 'profiles');
    mkdirSync(legacyProfilesDir, { recursive: true });
    writeFileSync(join(legacyProfilesDir, 'legacy-id.json'), JSON.stringify({
      id: 'legacy-id',
      name: 'LegacyFriend',
      personality: { description: 'legacy companion', style: 'calm' },
      server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
      createdAt: 1,
      updatedAt: 1,
    }), 'utf8');
    const legacyProfiles = new ProfileStore(legacyDir);
    assert.equal(legacyProfiles.get('legacy-id')?.playMode, 'survival');
    assert.equal(toPublicBotProfile(legacyProfiles.get('legacy-id')!).playMode, 'survival');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-28 | Profile API accepts survival defaults and rejects unavailable modes without mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-profile-play-mode-api-'));
  const dataDir = join(dir, 'data');
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir });
  try {
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;

    const explicitResponse = await fetch(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileInput('ExplicitSurvival', 'survival')),
    });
    assert.equal(explicitResponse.status, 201);
    const explicit = await explicitResponse.json() as { id: string; playMode: string };
    assert.equal(explicit.playMode, 'survival');

    const legacyResponse = await fetch(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileInput('LegacyClient')),
    });
    assert.equal(legacyResponse.status, 201);
    assert.equal((await legacyResponse.json() as { playMode: string }).playMode, 'survival');

    const profilesDir = join(dataDir, 'profiles');
    const beforeIds = readdirSync(profilesDir).sort();
    for (const invalidMode of ['creative', 'adventure', 1, null]) {
      const rejected = await fetch(`${origin}/api/profiles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileInput(`Rejected-${String(invalidMode)}`, invalidMode)),
      });
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual(readdirSync(profilesDir).sort(), beforeIds);

    for (const method of ['PATCH', 'PUT']) {
      const rejected = await fetch(`${origin}/api/profiles/${explicit.id}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playMode: 'creative' }),
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(hub.profileStore.get(explicit.id)?.playMode, 'survival');
  } finally {
    await closeHub(hub);
    rmSync(dir, { recursive: true, force: true });
  }
});
