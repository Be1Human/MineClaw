import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('FEAT-WEBUI-14 | unsaved global LLM test validates credentials and protocol', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-llm-config-validation-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const missingKey = await fetch(`${origin}/api/llm-configs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing key', baseUrl: 'https://api.example.test/v1', model: 'test-model' }),
    });
    assert.equal(missingKey.status, 400);
    assert.match((await missingKey.json() as { error: string }).error, /API Key/);

    const anthropic = await fetch(`${origin}/api/llm-configs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Anthropic', apiKey: 'local-test-key', baseUrl: 'https://api.anthropic.com', model: 'claude-test' }),
    });
    assert.equal(anthropic.status, 400);
    assert.match((await anthropic.json() as { error: string }).error, /OpenAI-compatible/);
  } finally {
    await closeServer(hub.httpServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-14 | global LLM tests use form input without persisting or leaking a key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-llm-config-test-'));
  const received: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      received.push({ authorization: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const formKey = 'form-local-test-key';
    const response = await fetch(`${origin}/api/llm-configs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Local mock', apiKey: formKey,
        baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, model: 'form-model',
      }),
    });
    const result = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.preview, 'OK');
    assert.equal(JSON.stringify(result).includes(formKey), false);
    assert.equal(received[0]?.authorization, `Bearer ${formKey}`);
    assert.equal(received[0]?.body.model, 'form-model');
    assert.equal(hub.llmAgentConfigStore.list().length, 0);
  } finally {
    await closeServer(hub.httpServer);
    await closeServer(upstream);
    rmSync(dir, { recursive: true, force: true });
  }
});
