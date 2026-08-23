import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { resolveProfileLlmConfig } from '../../../../apps/minecraft-companion/src/hub/llmConfig.js';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

test('FEAT-WEBUI-14 | legacy resolver keeps endpoint and model from one configuration layer', () => {
  const fallback = { apiKey: 'default-key', baseUrl: 'http://127.0.0.1:1234/v1', model: 'default-model' };
  assert.deepEqual(resolveProfileLlmConfig(
    { apiKey: 'legacy-placeholder', baseUrl: '', model: 'legacy-model' }, fallback,
  ), fallback);
  assert.deepEqual(resolveProfileLlmConfig(
    { apiKey: '', baseUrl: 'http://profile.test/v1', model: 'profile-model' }, fallback,
  ), { apiKey: 'default-key', baseUrl: 'http://profile.test/v1', model: 'profile-model' });
});

test('FEAT-WEBUI-14 | updating a global Agent reloads only its referenced runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-global-llm-refresh-'));
  const requests: Array<{ authorization: string; model: string }> = [];
  const provider = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string };
      requests.push({ authorization: String(req.headers.authorization ?? ''), model: String(body.model ?? '') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `local reply ${requests.length}` } }] }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });

  try {
    const selectedConfig = hub.llmAgentConfigStore.create({ name: 'Selected', apiKey: 'selected-key', baseUrl, model: 'selected-model' });
    const untouchedConfig = hub.llmAgentConfigStore.create({ name: 'Untouched', apiKey: 'untouched-key', baseUrl, model: 'untouched-model' });
    const profileInput = (name: string, llmConfigId: string) => ({
      name,
      personality: { description: `${name} companion`, style: 'calm' },
      server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
      llmConfigId,
    });
    const target = hub.profileStore.create(profileInput('RefreshTarget', selectedConfig.id));
    const untouched = hub.profileStore.create(profileInput('RefreshUntouched', untouchedConfig.id));
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;

    const waitForReply = (expectedName: string) => new Promise<void>((resolve, reject) => {
      const previous = hub.botManager.onChat;
      const timer = setTimeout(() => reject(new Error('timed out waiting for mock reply')), 10_000);
      hub.botManager.onChat = (botId, sender, _message, meta) => {
        previous?.(botId, sender, _message, meta);
        if (botId !== target.id || sender !== expectedName) return;
        clearTimeout(timer);
        resolve();
      };
    });

    let reply = waitForReply(target.name);
    await hub.botManager.chat(target.id, 'owner', 'first');
    await reply;
    assert.deepEqual(requests[0], { authorization: 'Bearer selected-key', model: 'selected-model' });

    const targetStartedAt = hub.botManager.getStatus(target.id)?.startedAt ?? 0;
    const untouchedStartedAt = hub.botManager.getStatus(untouched.id)?.startedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    const response = await fetch(`${origin}/api/llm-configs/${selectedConfig.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'selected-key-2', model: 'selected-model-2' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { restartedProfileCount: number }).restartedProfileCount, 1);
    assert.ok((hub.botManager.getStatus(target.id)?.startedAt ?? 0) > targetStartedAt);
    assert.equal(hub.botManager.getStatus(untouched.id)?.startedAt, untouchedStartedAt);

    reply = waitForReply(target.name);
    await hub.botManager.chat(target.id, 'owner', 'second');
    await reply;
    assert.deepEqual(requests[1], { authorization: 'Bearer selected-key-2', model: 'selected-model-2' });

    const blockedDelete = await fetch(`${origin}/api/llm-configs/${selectedConfig.id}`, { method: 'DELETE' });
    assert.equal(blockedDelete.status, 409);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-14 | settings page separates global Agent management from role selection', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(process.cwd(), 'web', 'src', 'components', 'SettingsPanel.vue'), 'utf8');
  assert.match(source, /LLM Agent 配置/);
  assert.match(source, /AI Agent/);
  assert.match(source, /llmConfigId/);
  assert.doesNotMatch(source, /selectedProfile\?\.llm/);
});

test('FEAT-WEBUI-14 | partner pages stay inside a persistent partner workspace', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(process.cwd(), 'web', 'src', 'App.vue'), 'utf8');
  const template = source.slice(0, source.indexOf('<script setup>'));

  assert.doesNotMatch(source, /globalView|app-global-nav/);
  assert.ok(template.indexOf('partner-sidebar') < template.indexOf('partner-workspace-bar'));
  assert.match(template, /v-if="workspaceView === 'brain'"/);
  assert.match(template, /v-else-if="workspaceView === 'settings'"/);
  assert.doesNotMatch(template, /ctrlTab === 'settings'/);
  assert.match(source, /mc\.workspaceTabs\.v1/);
  assert.match(source, /mc\.controlTabs\.v1/);
});
