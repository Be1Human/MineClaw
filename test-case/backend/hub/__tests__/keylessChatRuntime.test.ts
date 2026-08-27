import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

const requireFromWeb = createRequire(new URL('../../../../apps/minecraft-companion/web/package.json', import.meta.url));
const { io: createSocketClient } = requireFromWeb('socket.io-client') as typeof import('socket.io-client');

const profileInput = (name: string, llmConfigId?: string) => ({
  name,
  personality: { description: `${name} companion`, style: 'calm' },
  server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
  ...(llmConfigId ? { llmConfigId } : {}),
});

test('BUG-CROSS-79 | keyless runtime explains failure and hot configuration takes effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-keyless-chat-'));
  let providerRequests = 0;
  const provider = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    providerRequests++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '配置已经生效。' } }] }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  const hub = createHubServer(
    { port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') },
    { apiKey: 'default-must-not-be-used', baseUrl, model: 'default-model' },
  );
  const profile = hub.profileStore.create(profileInput('KeylessFriend'));

  const botReplies: string[] = [];
  const replyWaiters: Array<(message: string) => void> = [];
  const previousOnChat = hub.botManager.onChat;
  hub.botManager.onChat = (botId, sender, message, meta) => {
    previousOnChat?.(botId, sender, message, meta);
    if (botId !== profile.id || sender !== profile.name) return;
    botReplies.push(message);
    replyWaiters.splice(0).forEach(resolve => resolve(message));
  };
  const waitForReply = () => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for bot reply')), 10_000);
    replyWaiters.push(message => { clearTimeout(timer); resolve(message); });
  });

  try {
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    assert.equal(hub.botManager.getStatus(profile.id)?.status, 'awake');
    assert.equal(hub.botManager.getFullStatus(profile.id)?.companionPhase, 'awake');

    let reply = waitForReply();
    assert.notEqual(await hub.botManager.chat(profile.id, 'owner', '你好'), null);
    assert.match(await reply, /尚未配置 AI Agent/);
    assert.equal(providerRequests, 0, 'keyless runtime must not call the fallback provider');

    const config = hub.llmAgentConfigStore.create({ name: 'Local Mock', apiKey: 'mock-key', baseUrl, model: 'mock-model' });
    const patched = await fetch(`${origin}/api/profiles/${profile.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmConfigId: config.id }),
    });
    assert.equal(patched.status, 200);

    reply = waitForReply();
    assert.notEqual(await hub.botManager.chat(profile.id, 'owner', '现在可以了吗'), null);
    assert.match(await reply, /配置已经生效/);
    assert.equal(providerRequests, 1);

    const history = hub.botManager.getRecentChatMessages(profile.id, 20) ?? [];
    assert.ok(history.some(message => message.role === 'owner' && message.content === '你好'));
    assert.ok(history.some(message => message.role === 'bot' && /尚未配置 AI Agent/.test(message.content)));
    assert.ok(botReplies.length >= 2);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-CROSS-79 | socket acknowledgement distinguishes accepted and rejected submissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-chat-ack-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  const keyless = hub.profileStore.create(profileInput('AckFriend'));
  const broken = hub.profileStore.create(profileInput('BrokenFriend', 'missing-config'));
  let client: ReturnType<typeof createSocketClient> | undefined;

  try {
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    client = createSocketClient(origin, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve, reject) => {
      client!.once('connect', resolve);
      client!.once('connect_error', reject);
    });
    const submit = (data: unknown) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for chat acknowledgement')), 5_000);
      client!.emit('bot:chat', data, (ack: unknown) => { clearTimeout(timer); resolve(ack); });
    });

    assert.deepEqual(await submit({ botId: keyless.id, message: '   ' }), {
      ok: false, accepted: false,
      error: { code: 'INVALID_MESSAGE', message: '消息不能为空，请输入内容后重试。' },
    });
    assert.equal((await submit({ botId: 'missing-profile', message: 'hello' })).error.code, 'PROFILE_NOT_FOUND');
    assert.equal((await submit({ botId: broken.id, message: 'hello' })).error.code, 'RUNTIME_UNAVAILABLE');
    assert.deepEqual(await submit({ botId: keyless.id, message: 'hello' }), { ok: true, accepted: true });
  } finally {
    client?.close();
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
