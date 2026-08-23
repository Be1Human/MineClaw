import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

test('BUG-CROSS-24 · Express 5 生产静态托管覆盖根路由和 SPA，且不吞未知 API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-static-server-'));
  const staticDir = join(dir, 'renderer');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Memory UAT</title><main>release-ui</main>');
  const previous = process.env.SERVE_STATIC;
  process.env.SERVE_STATIC = staticDir;
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    await hub.listen();
    const address = hub.httpServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await fetch(`${origin}/`);
    const spa = await fetch(`${origin}/memory-route`);
    const unknownApi = await fetch(`${origin}/api/not-found`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /release-ui/);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /release-ui/);
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(await unknownApi.json(), { error: 'api route not found' });
  } finally {
    await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    if (previous === undefined) delete process.env.SERVE_STATIC;
    else process.env.SERVE_STATIC = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-CROSS-24 · 未设置 SERVE_STATIC 时纯 API Hub 仍可创建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-api-server-'));
  const previous = process.env.SERVE_STATIC;
  delete process.env.SERVE_STATIC;
  try {
    const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
    assert.ok(hub.app);
  } finally {
    if (previous === undefined) delete process.env.SERVE_STATIC;
    else process.env.SERVE_STATIC = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
