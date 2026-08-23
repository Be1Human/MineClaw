import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { io } = requireFromWeb('socket.io-client');

const hubOrigin = process.env.ELECTRON_SMOKE_HUB_ORIGIN ?? 'http://127.0.0.1:3000';
const expectedReply = '\u672c\u5730 Electron \u804a\u5929\u5192\u70df\u901a\u8fc7';
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
let profileId;
let socket;
let mockRequests = 0;

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
}

function close(server) {
  return new Promise(resolveClose => server.close(() => resolveClose()));
}

async function request(path, init) {
  const response = await fetch(`${hubOrigin}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function removeRuntimeArtifacts(id) {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const databases = [
    `v2-memory-${safeId}.db`,
    `chat-memory-${safeId}.db`,
    `world-map-${safeId}.db`,
  ];
  for (const database of databases) {
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(join(dataDir, `${database}${suffix}`), { force: true });
    }
  }
  await rm(join(dataDir, 'runs', safeId), { recursive: true, force: true });
  await rm(join(dataDir, 'strategies', safeId), { recursive: true, force: true });
}

function waitForAssistantReply(botId, assistantName) {
  return new Promise((resolveReply, rejectReply) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReply(new Error('\u7b49\u5f85\u5f02\u6b65\u804a\u5929\u6700\u7ec8\u56de\u590d\u8d85\u65f6'));
    }, 30_000);
    const onChat = data => {
      if (data?.botId !== botId || data?.sender !== assistantName) return;
      cleanup();
      resolveReply(data);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket?.off('bot:chat', onChat);
    };
    socket.on('bot:chat', onChat);
  });
}

const mockServer = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  mockRequests += 1;
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `electron-smoke-${mockRequests}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mineclaw-local-smoke',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: expectedReply },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  });
});

try {
  await request('/api/profiles');
  const address = await listen(mockServer);
  const mockOrigin = `http://127.0.0.1:${address.port}/v1`;
  const profile = await request('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: `ElectronSmoke-${process.pid}`,
      personality: {
        description: '\u672c\u5730\u684c\u9762\u804a\u5929\u5192\u70df\u6d4b\u8bd5',
        style: 'calm',
      },
      server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
      llm: {
        apiKey: 'local-smoke-key',
        baseUrl: mockOrigin,
        model: 'mineclaw-local-smoke',
      },
      memory: { semanticSearch: false },
    }),
  });
  profileId = profile.id;

  await request(`/api/bots/${profileId}/start`, { method: 'POST', body: '{}' });
  socket = io(hubOrigin, { transports: ['websocket'], timeout: 10_000 });
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once('connect', resolveConnect);
    socket.once('connect_error', rejectConnect);
  });

  const finalReply = waitForAssistantReply(profileId, profile.name);
  const chat = await request(`/api/bots/${profileId}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      sender: '\u6d4b\u8bd5\u4e3b\u4eba',
      message: '\u4f60\u597d',
    }),
  });
  if (typeof chat.reply !== 'string' || !chat.reply.includes('\u6b63\u5728\u601d\u8003')) {
    throw new Error(`\u804a\u5929\u63a5\u53e3\u672a\u8fd4\u56de\u5f02\u6b65\u5360\u4f4d\u54cd\u5e94\uff1a${JSON.stringify(chat)}`);
  }
  const assistantEvent = await finalReply;
  if (assistantEvent.message !== expectedReply) {
    throw new Error(`\u804a\u5929\u6700\u7ec8\u56de\u590d\u4e0d\u7b26\u5408\u9884\u671f\uff1a${JSON.stringify(assistantEvent)}`);
  }
  if (mockRequests !== 1) {
    throw new Error(`\u672c\u5730 Mock Provider \u8bf7\u6c42\u6570\u5f02\u5e38\uff1a${mockRequests}`);
  }

  console.log(JSON.stringify({
    ok: true,
    profileId,
    acceptedReply: chat.reply,
    finalReply: assistantEvent.message,
    mockRequests,
    paidProviderRequests: 0,
  }));
} finally {
  if (profileId) {
    await request(`/api/bots/${profileId}/stop`, { method: 'POST', body: '{}' }).catch(() => undefined);
    await request(`/api/profiles/${profileId}`, { method: 'DELETE' }).catch(() => undefined);
    await removeRuntimeArtifacts(profileId);
  }
  socket?.disconnect();
  await close(mockServer).catch(() => undefined);
}
