import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import { LlmAgentConfigStore } from '../../../../apps/minecraft-companion/src/hub/llmAgentConfigStore.js';
import { ProfileStore, toPublicBotProfile, type BotProfile } from '../../../../apps/minecraft-companion/src/hub/profileStore.js';

const SECRET = 'global-agent-secret-value';

function profileInput(llmConfigId?: string): Omit<BotProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'SecurityTest',
    personality: { description: 'security test', style: 'calm' },
    server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
    ...(llmConfigId ? { llmConfigId } : {}),
  };
}

test('FEAT-WEBUI-14 | public Profile and global config DTOs never expose API keys', () => {
  const profile: BotProfile = {
    ...profileInput('agent-1'),
    llm: { apiKey: SECRET, baseUrl: 'https://legacy.example.test/v1', model: 'legacy-model' },
    id: 'p1',
    createdAt: 1,
    updatedAt: 1,
  };
  const publicProfile = toPublicBotProfile(profile);
  assert.equal(JSON.stringify(publicProfile).includes(SECRET), false);
  assert.equal(Object.hasOwn(publicProfile, 'llm'), false);
  assert.equal(publicProfile.llmConfigId, 'agent-1');

  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-llm-agent-security-'));
  try {
    const configs = new LlmAgentConfigStore(dir);
    const config = configs.create({
      name: 'Primary Agent', apiKey: SECRET, baseUrl: 'https://api.example.test/v1', model: 'test-model',
    });
    const publicConfig = configs.toPublic(config, 1);
    assert.equal(JSON.stringify(publicConfig).includes(SECRET), false);
    assert.equal(Object.hasOwn(publicConfig, 'apiKey'), false);
    assert.equal(publicConfig.apiKeyConfigured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-14 | legacy profile migration preserves each role config and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-llm-agent-migration-'));
  try {
    const profiles = new ProfileStore(dir);
    const first = profiles.create({
      ...profileInput(),
      name: 'LanYi',
      llm: { apiKey: 'first-key', baseUrl: 'https://first.example.test/v1', model: 'first-model' },
    });
    const second = profiles.create({
      ...profileInput(),
      name: 'LanEr',
      llm: { apiKey: 'second-key', baseUrl: 'https://second.example.test/v1', model: 'second-model' },
    });
    const configs = new LlmAgentConfigStore(dir);

    configs.migrateLegacyProfiles(profiles);
    configs.migrateLegacyProfiles(profiles);

    const migratedFirst = profiles.get(first.id)!;
    const migratedSecond = profiles.get(second.id)!;
    assert.ok(migratedFirst.llmConfigId);
    assert.ok(migratedSecond.llmConfigId);
    assert.notEqual(migratedFirst.llmConfigId, migratedSecond.llmConfigId);
    assert.equal(migratedFirst.llm, undefined);
    assert.equal(migratedSecond.llm, undefined);
    assert.deepEqual(configs.get(migratedFirst.llmConfigId), {
      id: migratedFirst.llmConfigId,
      name: '迁移 - LanYi',
      apiKey: 'first-key',
      baseUrl: 'https://first.example.test/v1',
      model: 'first-model',
      createdAt: configs.get(migratedFirst.llmConfigId)!.createdAt,
      updatedAt: configs.get(migratedFirst.llmConfigId)!.updatedAt,
    });
    assert.equal(configs.get(migratedSecond.llmConfigId)?.model, 'second-model');
    assert.equal(configs.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-14 | public profile and LLM config APIs are redacted and reject invalid references', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-llm-agent-api-security-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const createConfig = await fetch(`${origin}/api/llm-configs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Private Agent', apiKey: SECRET, baseUrl: 'https://api.example.test/v1', model: 'test-model',
      }),
    });
    assert.equal(createConfig.status, 201);
    const config = await createConfig.json() as { id: string; apiKeyConfigured: boolean };
    assert.equal(JSON.stringify(config).includes(SECRET), false);
    assert.equal(config.apiKeyConfigured, true);

    const duplicateConfig = await fetch(`${origin}/api/llm-configs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'private agent', apiKey: 'another-key', baseUrl: 'https://api.other.test/v1', model: 'other-model',
      }),
    });
    assert.equal(duplicateConfig.status, 409);

    const blankPatch = await fetch(`${origin}/api/llm-configs/${config.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ', model: '' }),
    });
    assert.equal(blankPatch.status, 400);

    const invalidProfile = await fetch(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileInput('missing-agent')),
    });
    assert.equal(invalidProfile.status, 400);

    const legacyProfile = await fetch(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...profileInput(),
        llm: { apiKey: SECRET, baseUrl: 'https://api.example.test/v1', model: 'test-model' },
      }),
    });
    assert.equal(legacyProfile.status, 400);

    const profileResponse = await fetch(`${origin}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileInput(config.id)),
    });
    assert.equal(profileResponse.status, 201);
    const profile = await profileResponse.json() as { llmConfigId: string };
    assert.equal(profile.llmConfigId, config.id);
    assert.equal(JSON.stringify(profile).includes(SECRET), false);
    assert.equal(Object.hasOwn(profile, 'llm'), false);
  } finally {
    await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
