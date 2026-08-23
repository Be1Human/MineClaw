/**
 * FEAT-WEBUI-12 · ServerPresetStore 单元测试
 * 覆盖：首启种入默认本地服 · add/delete · 重启不重复种入 · 损坏文件不崩
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServerPresetStore } from '../../../../apps/minecraft-companion/src/hub/serverPresetStore.js';

describe('ServerPresetStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sps-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('首启种入默认本地服 127.0.0.1:25565', () => {
    const store = new ServerPresetStore(dir);
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].host, '127.0.0.1');
    assert.equal(list[0].port, 25565);
    assert.equal(list[0].name, '本地训练服');
    assert.ok(existsSync(join(dir, 'server-presets.json')));
  });

  test('add 返回带 id/createdAt 并持久化', () => {
    const store = new ServerPresetStore(dir);
    const p = store.add({ name: '远程服', host: '1.2.3.4', port: 25565 });
    assert.ok(p.id);
    assert.ok(p.createdAt > 0);
    assert.equal(store.list().length, 2);
    // 持久化到磁盘
    const onDisk = JSON.parse(readFileSync(join(dir, 'server-presets.json'), 'utf-8'));
    assert.equal(onDisk.length, 2);
  });

  test('delete 生效；删不存在返回 false', () => {
    const store = new ServerPresetStore(dir);
    const p = store.add({ name: 'x', host: 'h', port: 1 });
    assert.equal(store.delete(p.id), true);
    assert.equal(store.list().length, 1);
    assert.equal(store.delete('nope'), false);
  });

  test('重启（已有文件）不重复种入默认', () => {
    new ServerPresetStore(dir);          // 首启种入 1 个
    const store2 = new ServerPresetStore(dir);  // 重启加载
    assert.equal(store2.list().length, 1);
  });

  test('损坏文件不崩，退化为空', () => {
    writeFileSync(join(dir, 'server-presets.json'), '{ broken', 'utf-8');
    const store = new ServerPresetStore(dir);
    assert.equal(store.list().length, 0);
  });

  test('旧服务器配置迁移为默认关闭皮肤同步', () => {
    writeFileSync(join(dir, 'server-presets.json'), JSON.stringify([{
      id: 'legacy', name: '旧服', host: 'example.test', port: 25565, createdAt: 1,
    }]), 'utf-8');
    const store = new ServerPresetStore(dir);
    assert.deepEqual(store.get('legacy')?.skinSync, { mode: 'disabled' });
  });

  test('update 持久化 SkinsRestorer 同步模式', () => {
    const store = new ServerPresetStore(dir);
    const preset = store.list()[0]!;
    const updated = store.update(preset.id, { skinSync: { mode: 'skinsrestorer' } });
    assert.equal(updated?.skinSync?.mode, 'skinsrestorer');
    const reloaded = new ServerPresetStore(dir);
    assert.equal(reloaded.get(preset.id)?.skinSync?.mode, 'skinsrestorer');
  });
});
