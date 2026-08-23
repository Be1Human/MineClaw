import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkinCommand, skinDataMatches } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/connection.js';

describe('Mineflayer skin synchronization', () => {
  const url = 'https://textures.minecraft.net/texture/abcdef123456';

  test('使用 SkinsRestorer 当前 URL 命令并传递模型', () => {
    assert.equal(buildSkinCommand(url, 'classic'), `/skin url ${url} classic`);
    assert.equal(buildSkinCommand(url, 'slim'), `/skin url ${url} slim`);
  });

  test('只接受 Minecraft 签名纹理地址', () => {
    assert.throws(() => buildSkinCommand('https://example.com/skin.png', 'classic'), /invalid_texture_url/);
  });

  test('按纹理 hash 和 classic/slim 验证服务器回执', () => {
    assert.equal(skinDataMatches({ url, model: null }, url, 'classic'), true);
    assert.equal(skinDataMatches({ url, model: 'slim' }, url, 'slim'), true);
    assert.equal(skinDataMatches({ url, model: null }, url, 'slim'), false);
    assert.equal(skinDataMatches({ url: 'https://textures.minecraft.net/texture/other', model: null }, url, 'classic'), false);
  });
});
