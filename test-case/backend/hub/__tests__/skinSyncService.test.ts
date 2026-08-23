import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkinSyncService } from '../../../../apps/minecraft-companion/src/hub/skinSyncService.js';
import type { BotProfile } from '../../../../apps/minecraft-companion/src/hub/profileStore.js';
import type { ServerPreset } from '../../../../apps/minecraft-companion/src/hub/serverPresetStore.js';

function pngDataUrl(width = 64, height = 64): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function profile(texture = pngDataUrl(), model: 'classic' | 'slim' = 'classic'): BotProfile {
  return {
    id: 'bot-1', name: 'LanYi', skinTexture: texture, skinModel: model,
    personality: { description: '', style: '' },
    server: { presetId: 'server-1', host: '127.0.0.1', port: 25565, auth: 'offline' },
    createdAt: 1, updatedAt: 1,
  };
}

function preset(mode: 'disabled' | 'skinsrestorer'): ServerPreset {
  return {
    id: 'server-1', name: '测试服', host: '127.0.0.1', port: 25565, auth: 'offline',
    skinSync: { mode }, createdAt: 1,
  };
}

describe('SkinSyncService', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skin-sync-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('服务器未启用同步时不上传皮肤', async () => {
    let calls = 0;
    const service = new SkinSyncService(dir, async () => { calls++; throw new Error('unexpected'); });
    const result = await service.prepare(profile(), preset('disabled'));
    assert.equal(result.state, 'unsupported');
    assert.equal(result.reasonCode, 'skin_sync_disabled');
    assert.equal(calls, 0);
  });

  test('上传 64x64 PNG 并缓存签名纹理', async () => {
    let calls = 0;
    const textureUrl = 'https://textures.minecraft.net/texture/abcdef123456';
    const request: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ skin: { texture: { url: { skin: textureUrl } } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const first = await new SkinSyncService(dir, request).prepare(profile(), preset('skinsrestorer'));
    const second = await new SkinSyncService(dir, request).prepare(profile(), preset('skinsrestorer'));
    assert.equal(first.state, 'ready');
    assert.equal(second.state, 'ready');
    if (first.state === 'ready') {
      assert.equal(first.textureUrl, textureUrl);
      assert.equal(first.model, 'classic');
    }
    assert.equal(calls, 1);
  });

  test('拒绝非 64x64 皮肤', async () => {
    const service = new SkinSyncService(dir, async () => { throw new Error('unexpected'); });
    const result = await service.prepare(profile(pngDataUrl(128, 64)), preset('skinsrestorer'));
    assert.equal(result.state, 'failed');
    assert.equal(result.reasonCode, 'invalid_skin');
    assert.match(result.message, /64×64/);
  });

  test('textures.minecraft.net 地址无需再次上传并保留 slim', async () => {
    let calls = 0;
    const textureUrl = 'https://textures.minecraft.net/texture/abcdef123456';
    const service = new SkinSyncService(dir, async () => { calls++; throw new Error('unexpected'); });
    const result = await service.prepare(profile(textureUrl, 'slim'), preset('skinsrestorer'));
    assert.equal(result.state, 'ready');
    if (result.state === 'ready') assert.equal(result.model, 'slim');
    assert.equal(calls, 0);
  });
});
