import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import { ChatMemoryService } from '../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';

function profileInput(name: string, baseUrl = 'http://127.0.0.1:1/v1') {
  return {
    name,
    personality: { description: `${name} companion`, style: 'calm' },
    server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
    llm: { apiKey: 'local-test-key', baseUrl, model: 'local-test-model' },
  };
}

async function closeHub(hub: ReturnType<typeof createHubServer>): Promise<void> {
  await hub.botManager.stopAll();
  if (hub.httpServer.listening) {
    await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
  }
}

test('FEAT-CROSS-11 | Hub 冷启动全部 Profile，重复 start 幂等且不请求 LLM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-auto-ready-'));
  let providerRequests = 0;
  const provider = createServer((_req, res) => {
    providerRequests += 1;
    res.writeHead(500).end();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address() as AddressInfo;
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    const baseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
    const first = hub.profileStore.create(profileInput('AutoReadyA', baseUrl));
    hub.profileStore.create(profileInput('AutoReadyB', baseUrl));

    await hub.listen();
    const bots = hub.botManager.listAll();
    assert.equal(bots.length, 2);
    assert.equal(bots.every(bot => bot.fullStatus?.companionPhase === 'awake'), true);
    assert.equal(bots.every(bot => bot.fullStatus?.embodied === false), true);

    const before = hub.botManager.getStatus(first.id);
    const repeated = await hub.botManager.start(first);
    assert.equal(repeated.startedAt, before?.startedAt);
    assert.equal(hub.botManager.listAll().length, 2);

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(providerRequests, 0);
  } finally {
    await closeHub(hub);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-11 | 历史消息按 Profile 恢复，新建自动就绪，删除同步停止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-chat-history-ready-'));
  const dataDir = join(dir, 'data');
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir });
  try {
    const first = hub.profileStore.create(profileInput('HistoryA'));
    const second = hub.profileStore.create(profileInput('HistoryB'));
    const memoryA = new ChatMemoryService({
      dbPath: join(dataDir, `chat-memory-${first.id}.db`),
      profileId: first.id,
      embeddingProvider: null,
    });
    memoryA.recordMessages([
      { id: 'a-owner', sessionId: 's-a', role: 'owner', content: 'A 的旧问题', timestamp: 10 },
      { id: 'a-bot', sessionId: 's-a', role: 'bot', content: 'A 的旧回答', timestamp: 20 },
    ]);
    memoryA.close();
    const memoryB = new ChatMemoryService({
      dbPath: join(dataDir, `chat-memory-${second.id}.db`),
      profileId: second.id,
      embeddingProvider: null,
    });
    memoryB.recordMessage({
      id: 'b-owner', sessionId: 's-b', role: 'owner', content: 'B 的独立历史', timestamp: 30,
    });
    memoryB.close();

    await hub.listen();
    const address = hub.httpServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    const historyA = await fetch(`${origin}/api/bots/${first.id}/chat-memory/messages?limit=50`);
    assert.equal(historyA.status, 200);
    assert.deepEqual(
      (await historyA.json() as { messages: Array<{ content: string }> }).messages.map(message => message.content),
      ['A 的旧问题', 'A 的旧回答'],
    );
    const historyB = await fetch(`${origin}/api/bots/${second.id}/chat-memory/messages?limit=50`);
    assert.deepEqual(
      (await historyB.json() as { messages: Array<{ content: string }> }).messages.map(message => message.content),
      ['B 的独立历史'],
    );

    const createdAgent = hub.llmAgentConfigStore.create({
      name: 'CreatedReady Agent',
      apiKey: 'local-test-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'local-test-model',
    });
    const { llm: _legacyLlm, ...createdProfileInput } = profileInput('CreatedReady');
    const createdResponse = await fetch(`${origin}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...createdProfileInput, llmConfigId: createdAgent.id }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string };
    assert.equal(hub.botManager.getFullStatus(created.id)?.companionPhase, 'awake');

    const deletedResponse = await fetch(`${origin}/api/profiles/${created.id}`, { method: 'DELETE' });
    assert.equal(deletedResponse.status, 200);
    assert.equal(hub.profileStore.get(created.id), undefined);
    assert.equal(hub.botManager.getStatus(created.id), undefined);
  } finally {
    await closeHub(hub);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-11 | 单 Profile 冷启动失败不阻塞 Hub 与其他 Profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-auto-ready-isolation-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    const broken = hub.profileStore.create(profileInput('BrokenProfile'));
    const healthy = hub.profileStore.create(profileInput('HealthyProfile'));
    const originalStart = hub.botManager.start.bind(hub.botManager);
    hub.botManager.start = async profile => {
      if (profile.id === broken.id) throw new Error('injected startup failure');
      return originalStart(profile);
    };

    await hub.listen();
    assert.equal(hub.httpServer.listening, true);
    assert.equal(hub.botManager.getStatus(broken.id), undefined);
    assert.equal(hub.botManager.getFullStatus(healthy.id)?.companionPhase, 'awake');
  } finally {
    await closeHub(hub);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-11 | WebUI 不再暴露纯聊天启停按钮并加载历史', () => {
  const source = readFileSync(join(process.cwd(), 'web', 'src', 'App.vue'), 'utf8');
  assert.doesNotMatch(source, /@click="startBot"/);
  assert.doesNotMatch(source, /@click="stopBot"/);
  assert.doesNotMatch(source, />陪聊<\/button>/);
  assert.doesNotMatch(source, />休息<\/button>/);
  assert.match(source, /@click="joinGame"/);
  assert.match(source, /@click="leaveGame"/);
  assert.match(source, /chat-memory\/messages\?limit=50/);
});
