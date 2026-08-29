import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveElectronDevStrategy } from '../../../apps/minecraft-companion/scripts/electronDevStrategy.mjs';

test('Hub 与 Web 同时健康时复用现有开发服务', async () => {
  const calls = [];
  const strategy = await resolveElectronDevStrategy({
    env: {},
    fetchImpl: async url => {
      calls.push(url);
      return { ok: true };
    },
  });
  assert.deepEqual(strategy, {
    mode: 'attach',
    hubUrl: 'http://127.0.0.1:3000',
    rendererUrl: 'http://127.0.0.1:5173',
  });
  assert.deepEqual(calls, [
    'http://127.0.0.1:3000/api/profiles',
    'http://127.0.0.1:5173/',
  ]);
});

test('任一开发服务不可用时保持独立 Electron 启动', async () => {
  const strategy = await resolveElectronDevStrategy({
    env: {},
    fetchImpl: async url => ({ ok: !url.includes(':5173') }),
  });
  assert.equal(strategy.mode, 'standalone');
});

test('IPv4 Hub 不可用时会复用 localhost 上的现有 Hub', async () => {
  const calls = [];
  const strategy = await resolveElectronDevStrategy({
    env: {},
    fetchImpl: async url => {
      calls.push(url);
      return { ok: !url.startsWith('http://127.0.0.1:3000') };
    },
  });
  assert.equal(strategy.mode, 'attach');
  assert.equal(strategy.hubUrl, 'http://localhost:3000');
  assert.equal(strategy.rendererUrl, 'http://127.0.0.1:5173');
  assert.ok(calls.includes('http://localhost:3000/api/profiles'));
});

test('复用地址支持环境覆盖并归一结尾斜杠', async () => {
  const strategy = await resolveElectronDevStrategy({
    env: {
      MINECLAW_DEV_HUB_URL: 'http://localhost:3300/',
      MINECLAW_DEV_RENDERER_URL: 'http://localhost:5300/',
    },
    fetchImpl: async () => ({ ok: true }),
  });
  assert.equal(strategy.hubUrl, 'http://localhost:3300');
  assert.equal(strategy.rendererUrl, 'http://localhost:5300');
});
