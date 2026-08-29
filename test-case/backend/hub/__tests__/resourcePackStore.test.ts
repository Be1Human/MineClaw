import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { ResourcePackStore } from '../../../../apps/minecraft-companion/src/hub/resourcePacks/resourcePackStore.js';
import { ResourcePackError, type ResourcePackLimits } from '../../../../apps/minecraft-companion/src/hub/resourcePacks/types.js';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import { seedBuiltinResourcePack } from '../../../../apps/minecraft-companion/src/hub/resourcePacks/builtinResourcePack.js';
import type { AddressInfo } from 'node:net';

const LIMITS: ResourcePackLimits = {
  maxPackBytes: 2 * 1024 * 1024,
  maxPackEntries: 100,
  maxPackFileBytes: 1024 * 1024,
  maxExpandedPackBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxImageDimension: 4096,
};
const BUILTIN_LIMITS: ResourcePackLimits = {
  maxPackBytes: 64 * 1024 * 1024,
  maxPackEntries: 20_000,
  maxPackFileBytes: 16 * 1024 * 1024,
  maxExpandedPackBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 500,
  maxImageDimension: 4096,
};
const BUILTIN_PACK_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/minecraft-companion/builtin-packs/mineclaw-open-blocks.zip',
);

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

function requestBytes(url: string): Promise<{ status: number; body: Buffer; contentType: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpGet(url, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
        contentType: String(response.headers['content-type'] ?? ''),
      }));
    });
    request.on('error', rejectRequest);
  });
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

test('FEAT-WEBUI-27-005 | 内置开源视觉资源包自动播种且重复启动幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-builtin-pack-'));
  try {
    const store = new ResourcePackStore(dir, () => BUILTIN_LIMITS);
    const packagedEntries = Object.keys(unzipSync(readFileSync(BUILTIN_PACK_PATH)));
    assert.ok(packagedEntries.every(path => (
      path === 'pack.mcmeta'
      || path === 'LICENSE.txt'
      || path === 'MINECLAW-PROVENANCE.json'
      || path.startsWith('assets/minecraft/blockstates/')
      || path.startsWith('assets/minecraft/models/block/')
      || path.startsWith('assets/minecraft/textures/block/')
      || path.startsWith('assets/minecraft/textures/item/')
    )), '内置 ZIP 不得包含声音、音乐、GUI、字体、实体、物品模型或世界文件');
    store.import({
      archive: testPack({ declaredVersion: '1.21', license: 'MIT' }),
      fileName: 'mineclaw-open-blocks.zip',
      minecraftVersion: '1.21',
      source: 'mineclaw-original',
      licenseId: 'MIT',
      distributable: true,
    });
    const first = seedBuiltinResourcePack(store, BUILTIN_PACK_PATH);
    const second = seedBuiltinResourcePack(store, BUILTIN_PACK_PATH);
    assert.equal(first.id, second.id);
    assert.equal(store.list().length, 1, '升级内置包后应清理同名旧缓存');
    assert.equal(first.source, 'mineclaw-original');
    assert.equal(first.licenseId, 'MIT');
    assert.equal(first.distributable, true);
    assert.equal(first.minecraftVersion, '1.21');
    assert.ok(store.readFile(first.id, 'assets/minecraft/textures/block/stone.png'));
    assert.ok(store.readFile(first.id, 'assets/minecraft/textures/item/oak_door.png'));
    assert.match(new TextDecoder().decode(store.readFile(first.id, 'MINECLAW-PROVENANCE.json')!), /Love-and-Tolerance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-WEBUI-ICON-01 | 背包 item/block 图标只从内置包读取且不创建下载缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-builtin-icons-'));
  const dataDir = join(dir, 'data');
  const hub = createHubServer({
    host: '127.0.0.1', port: 0, dataDir, builtinResourcePackPath: BUILTIN_PACK_PATH,
  });
  const originalFetch = globalThis.fetch;
  let externalFetchCalls = 0;
  globalThis.fetch = (async () => {
    externalFetchCalls += 1;
    throw new Error('external fetch is disabled for the inventory icon test');
  }) as typeof fetch;
  try {
    await hub.listen();
    const port = (hub.httpServer.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/icon`;

    const item = await requestBytes(`${base}/oak_door`);
    assert.equal(item.status, 200);
    assert.match(item.contentType, /^image\/png/);
    assert.deepEqual([...item.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const block = await requestBytes(`${base}/oak_log`);
    assert.equal(block.status, 200);
    assert.match(block.contentType, /^image\/png/);

    assert.equal((await requestBytes(`${base}/missing_icon_fixture`)).status, 404);
    assert.equal((await requestBytes(`${base}/oak-log`)).status, 400);
    assert.equal(externalFetchCalls, 0);
    assert.equal(existsSync(join(dataDir, 'icon-cache')), false);
  } finally {
    globalThis.fetch = originalFetch;
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(done => hub.httpServer.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-27-005 | Hub 启动后资源包 API 直接提供内置包', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-builtin-pack-api-'));
  const hub = createHubServer({
    host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), builtinResourcePackPath: BUILTIN_PACK_PATH,
  });
  try {
    await hub.listen();
    const port = (hub.httpServer.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/resource-packs`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { packs: Array<{ source: string; licenseId: string }> };
    assert.equal(payload.packs.length, 1);
    assert.deepEqual(payload.packs[0] && {
      source: payload.packs[0].source,
      licenseId: payload.packs[0].licenseId,
    }, { source: 'mineclaw-original', licenseId: 'MIT' });
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(done => hub.httpServer.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
