import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  SQLITE_NATIVE_BINDING_ENV,
  configuredSqliteNativeBinding,
  openSqliteDatabase,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/sqliteDatabase.js';

const originalBinding = process.env[SQLITE_NATIVE_BINDING_ENV];

afterEach(() => {
  if (originalBinding === undefined) {
    delete process.env[SQLITE_NATIVE_BINDING_ENV];
  } else {
    process.env[SQLITE_NATIVE_BINDING_ENV] = originalBinding;
  }
});

describe('SQLite native binding 隔离', () => {
  it('未配置显式 binding 时沿用当前 Node 默认二进制', () => {
    delete process.env[SQLITE_NATIVE_BINDING_ENV];
    const db = openSqliteDatabase(':memory:');
    try {
      db.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
      db.prepare('INSERT INTO smoke (value) VALUES (?)').run('node-default');
      const row = db.prepare('SELECT value FROM smoke').get() as { value: string };
      assert.equal(row.value, 'node-default');
    } finally {
      db.close();
    }
  });

  it('显式 binding 存在时解析为绝对路径并可打开数据库', () => {
    const binding = resolve(
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    );
    assert.equal(existsSync(binding), true);
    process.env[SQLITE_NATIVE_BINDING_ENV] = binding;

    assert.equal(configuredSqliteNativeBinding(), binding);
    const db = openSqliteDatabase(':memory:');
    try {
      assert.equal(
        (db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok,
        1,
      );
    } finally {
      db.close();
    }
  });

  it('显式 binding 不存在时 fail fast，不回退共享二进制', () => {
    process.env[SQLITE_NATIVE_BINDING_ENV] = resolve(
      'node_modules/.cache/mineclaw-native/missing/better_sqlite3.node',
    );
    assert.throws(
      () => openSqliteDatabase(':memory:'),
      /MINECLAW_SQLITE_NATIVE_BINDING 指向不存在的文件/,
    );
  });
});
