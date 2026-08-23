/**
 * BotMemoryStore Unit Tests · FEAT-L7-09（Hermes 内置记忆移植）
 *
 * Framework: node:test + node:assert/strict
 * 用临时目录，避免污染真实 data/memories。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotMemoryStore } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/botMemory.js';

function freshStore(extra?: Partial<{ recallMode: 'always' | 'index'; maxInject: number; perOwnerUser: boolean }>) {
  const dir = mkdtempSync(join(tmpdir(), 'botmem-'));
  const store = new BotMemoryStore({ dir, ...extra }, () => {});
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('BotMemoryStore', () => {
  test('空目录 load() 返回空串、不抛', () => {
    const { store, cleanup } = freshStore();
    assert.equal(store.load(), '');
    assert.deepEqual(store.read('user'), []);
    cleanup();
  });

  test('append(user) → read 含该条 + 文件被创建', () => {
    const { dir, store, cleanup } = freshStore();
    const ok = store.append('主人喜欢晚上一起挖矿', 'user');
    assert.equal(ok, true);
    assert.deepEqual(store.read('user'), ['主人喜欢晚上一起挖矿']);
    assert.ok(existsSync(join(dir, 'USER.md')));
    cleanup();
  });

  test('重复文本 append → 去重，只一条', () => {
    const { store, cleanup } = freshStore();
    assert.equal(store.append('我讨厌僵尸', 'user'), true);
    assert.equal(store.append('我讨厌僵尸', 'user'), false);
    assert.equal(store.read('user').length, 1);
    cleanup();
  });

  test('memory / user 两 scope 分流到不同文件', () => {
    const { dir, store, cleanup } = freshStore();
    store.append('这个服晚上怪多', 'memory');
    store.append('叫我老板', 'user');
    assert.ok(existsSync(join(dir, 'MEMORY.md')));
    assert.deepEqual(store.read('memory'), ['这个服晚上怪多']);
    assert.deepEqual(store.read('user'), ['叫我老板']);
    cleanup();
  });

  test('load() 同时含 USER + MEMORY 段', () => {
    const { store, cleanup } = freshStore();
    store.append('我喜欢钻石', 'user');
    store.append('主人话不多', 'memory');
    const block = store.load();
    assert.match(block, /关于主人/);
    assert.match(block, /我喜欢钻石/);
    assert.match(block, /你记下的事/);
    assert.match(block, /主人话不多/);
    cleanup();
  });

  test('空文本 append 被拒', () => {
    const { store, cleanup } = freshStore();
    assert.equal(store.append('   ', 'user'), false);
    assert.equal(store.read('user').length, 0);
    cleanup();
  });

  test('load() 超 maxInject → 截断，保留最近', () => {
    const { store, cleanup } = freshStore({ maxInject: 3 });
    for (let i = 1; i <= 5; i++) store.append(`事实${i}`, 'user');
    const block = store.load();
    assert.ok(!block.includes('事实1'), '最旧的应被截断');
    assert.ok(block.includes('事实5'), '最新的应保留');
    cleanup();
  });

  test('recallMode=index → 注入上限更小（≤20）', () => {
    const { store, cleanup } = freshStore({ recallMode: 'index', maxInject: 50 });
    for (let i = 1; i <= 25; i++) store.append(`u${i}`, 'user');
    const lines = store.load().split('\n').filter((l) => l.startsWith('- '));
    assert.ok(lines.length <= 20, `index 模式应 ≤20，实际 ${lines.length}`);
    cleanup();
  });

  test('perOwnerUser=true → 按主人分文件', () => {
    const { dir, store, cleanup } = freshStore({ perOwnerUser: true });
    store.append('A 喜欢挖矿', 'user', 'alice');
    assert.ok(existsSync(join(dir, 'alice', 'USER.md')));
    assert.deepEqual(store.read('user', 'alice'), ['A 喜欢挖矿']);
    assert.deepEqual(store.read('user', 'bob'), [], '不同主人互不可见');
    cleanup();
  });
});
