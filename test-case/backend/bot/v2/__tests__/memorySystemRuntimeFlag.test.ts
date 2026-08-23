import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { V2Runtime } from '../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import { createMockBot } from './mocks/index.js';

test('FEAT-CROSS-13 · feature flag disables unified recall without breaking existing chat memory', () => {
  const bot = createMockBot();
  const runtime = new V2Runtime({
    game: bot.game, nav: bot.nav, embodied: false,
    ownerName: 'TestOwner', botName: 'FlagOff',
    dbPath: ':memory:', worldMapDbPath: ':memory:', chatMemoryDbPath: ':memory:',
    memorySystemEnabled: false,
  });
  runtime.start();
  try {
    assert.equal((runtime as unknown as { memorySystemActive: boolean }).memorySystemActive, false);
    runtime.chatMemory.recordMessage({ id: 'm1', sessionId: 's', role: 'owner', content: '记住蓝色纸船计划', timestamp: 1 });
    assert.equal(runtime.chatMemory.searchMessages('蓝色纸船', 5).length, 1);
  } finally {
    runtime.stop();
  }
});

test('FEAT-CROSS-13 · catalog open failure degrades to the legacy memory path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-catalog-fallback-'));
  const bot = createMockBot();
  const logs: string[] = [];
  const runtime = new V2Runtime({
    game: bot.game, nav: bot.nav, embodied: false,
    ownerName: 'TestOwner', botName: 'CatalogFallback',
    dbPath: ':memory:', worldMapDbPath: ':memory:', chatMemoryDbPath: ':memory:',
    memoryCatalogPath: dir,
    onLog: (_level, message) => logs.push(message),
  });
  runtime.start();
  try {
    assert.equal((runtime as unknown as { memorySystemActive: boolean }).memorySystemActive, false);
    assert.ok(logs.some(message => message.includes('Catalog 启动失败')));
    assert.doesNotThrow(() => runtime.chatMemory.toPromptContext('蓝色纸船'));
  } finally {
    runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
