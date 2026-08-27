import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ResourcePackStore } from '../../../../apps/minecraft-companion/src/hub/resourcePacks/resourcePackStore.js';
import { ResourcePackError, type ResourcePackLimits } from '../../../../apps/minecraft-companion/src/hub/resourcePacks/types.js';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import type { AddressInfo } from 'node:net';

const LIMITS: ResourcePackLimits = {
  maxPackBytes: 2 * 1024 * 1024,
  maxPackEntries: 100,
  maxPackFileBytes: 1024 * 1024,
  maxExpandedPackBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxImageDimension: 4096,
};

function pngHeader(width = 16, height = 16): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function testPack(options: {
  declaredVersion?: string;
  license?: string;
  extra?: Record<string, Uint8Array>;
} = {}): Uint8Array {
  const mineclaw: Record<string, string> = {};
  if (options.declaredVersion !== undefined) mineclaw.game_version = options.declaredVersion;
  if (options.license !== undefined) mineclaw.license = options.license;
  return zipSync({
    'pack.mcmeta': strToU8(JSON.stringify({
      pack: { pack_format: 34, description: { text: 'MineClaw self-authored fixture' } },
      mineclaw,
    })),
    'LICENSE.txt': strToU8('CC0-1.0 self-authored test fixture'),
    'assets/mineclaw/blockstates/probe.json': strToU8(JSON.stringify({ variants: { '': { model: 'mineclaw:block/probe' } } })),
    'assets/mineclaw/models/block/probe.json': strToU8(JSON.stringify({
      textures: { all: 'mineclaw:block/probe' },
      elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all' } } }],
    })),
    'assets/mineclaw/textures/block/probe.png': pngHeader(),
    ...options.extra,
  }, { level: 6 });
}

function expectPackError(action: () => unknown, code: ResourcePackError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof ResourcePackError && error.code === code);
}

test('FEAT-WEBUI-27-001 | 自制资源包安全导入、缓存幂等并可读取模型纹理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-resource-pack-'));
  try {
    const store = new ResourcePackStore(dir, () => LIMITS);
    const archive = testPack({ declaredVersion: '1.21', license: 'CC0-1.0' });
    const input = {
      archive,
      fileName: 'mineclaw-fixture.zip',
      minecraftVersion: '1.21',
      source: 'mineclaw-original' as const,
      distributable: true,
    };
    const first = store.import(input);
    const second = store.import(input);

    assert.equal(first.id, second.id);
    assert.equal(first.versionVerified, true);
    assert.equal(first.licenseId, 'CC0-1.0');
    assert.equal(store.list().length, 1);
    assert.match(new TextDecoder().decode(store.readFile(first.id, 'assets/mineclaw/models/block/probe.json')!), /elements/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-27-001 | 拒绝路径穿越、版本错配、无授权自有包和异常图片', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-resource-pack-policy-'));
  try {
    const store = new ResourcePackStore(dir, () => LIMITS);
    const base = { fileName: 'fixture.zip', minecraftVersion: '1.21', source: 'local-import' as const };
    expectPackError(() => store.import({ ...base, archive: testPack({ extra: { '../escape.txt': strToU8('no') } }) }), 'PACK_UNSAFE_PATH');
    expectPackError(() => store.import({ ...base, archive: testPack({ declaredVersion: '1.20.6' }) }), 'PACK_VERSION_MISMATCH');
    expectPackError(() => store.import({ ...base, archive: testPack({ extra: { 'assets/mineclaw/textures/block/huge.png': pngHeader(8192, 16) } }) }), 'PACK_INVALID_IMAGE');
    expectPackError(() => store.import({
      ...base,
      archive: testPack(),
      source: 'mineclaw-original',
      distributable: false,
    }), 'PACK_LICENSE_REQUIRED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-27-001 | 拒绝高压缩比 ZIP 炸弹', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-resource-pack-bomb-'));
  try {
    const store = new ResourcePackStore(dir, () => ({ ...LIMITS, maxCompressionRatio: 4 }));
    const archive = testPack({ extra: { 'assets/mineclaw/models/block/repeated.json': strToU8('A'.repeat(32_000)) } });
    expectPackError(() => store.import({
      archive,
      fileName: 'bomb.zip',
      minecraftVersion: '1.21',
      source: 'local-import',
    }), 'PACK_COMPRESSION_RATIO_TOO_HIGH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-27-001 | HTTP 导入接口不暴露原始 ZIP 且只提供缓存内文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-resource-pack-api-'));
  const hub = createHubServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data') });
  try {
    await hub.listen();
    const port = (hub.httpServer.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/resource-packs?fileName=fixture.zip&minecraftVersion=1.21`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: Buffer.from(testPack({ declaredVersion: '1.21' })),
    });
    assert.equal(response.status, 201);
    const descriptor = await response.json() as { id: string };

    const model = await fetch(`${base}/api/resource-packs/${descriptor.id}/files/assets/mineclaw/models/block/probe.json`);
    assert.equal(model.status, 200);
    assert.match(await model.text(), /mineclaw:block\/probe/);
    assert.equal((await fetch(`${base}/api/resource-packs/${descriptor.id}/archive.zip`)).status, 404);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
