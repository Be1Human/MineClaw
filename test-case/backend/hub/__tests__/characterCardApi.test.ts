import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import { createCharacterTemplate } from '../../../../apps/minecraft-companion/src/character/templates.js';

test('FEAT-CROSS-12 · 角色卡模板、校验、保存和能力门 API 闭环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-character-card-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') }, {
    apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model',
  });
  try {
    const profile = hub.profileStore.create({
      name: 'RoleTest', ownerUsername: 'qxy',
      personality: { description: 'legacy persona', style: 'calm' },
      server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
      llm: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model' },
    });
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;

    const templates = await fetch(`${origin}/api/character-card/templates`);
    assert.equal(templates.status, 200);
    assert.equal((await templates.json() as unknown[]).length, 2);

    const card = createCharacterTemplate('minecraft_native', { characterName: '云杉', userName: 'qxy' });
    card.performance.capabilities.minecraft = false;
    const save = await fetch(`${origin}/api/profiles/${profile.id}/character-card`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card),
    });
    assert.equal(save.status, 200);
    assert.equal(hub.profileStore.getCharacterCard(profile.id)?.character.identity.name, '云杉');

    const join = await fetch(`${origin}/api/bots/${profile.id}/join-game`, { method: 'POST' });
    assert.equal(join.status, 409);

    const invalid = structuredClone(card) as any;
    invalid.schemaVersion = 9;
    const rejected = await fetch(`${origin}/api/profiles/${profile.id}/character-card`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400);
    assert.equal(hub.profileStore.getCharacterCard(profile.id)?.schemaVersion, 1);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-18 · 角色设置页暴露三档任务进展汇报并兼容旧卡默认值', () => {
  const source = readFileSync(join(process.cwd(), 'web', 'src', 'components', 'SettingsPanel.vue'), 'utf8');
  assert.match(source, /v-model="characterCard\.performance\.progressReportLevel"/);
  assert.match(source, /value="quiet"/);
  assert.match(source, /value="balanced"/);
  assert.match(source, /value="talkative"/);
  assert.match(source, /progressReportLevel \?\?= 'balanced'/);
});
