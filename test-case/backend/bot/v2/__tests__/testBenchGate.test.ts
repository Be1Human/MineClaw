import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { V2Runtime } from '../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import { __setTuningOverride, tuningDefaults } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import { createMockBot } from './mocks/index.js';

test('FEAT-CROSS-20 · TestBench 默认关闭且可由热调参显式开启', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'mineclaw-bench-gate-'));
  const bot = createMockBot();
  const runtime = new V2Runtime({
    game: bot.game,
    nav: bot.nav,
    embodied: false,
    ownerName: 'TestOwner',
    botName: 'MineFriend',
    tickMs: 20,
    blockingExecute: true,
    dbPath: ':memory:',
    worldMapDbPath: ':memory:',
    chatMemoryDbPath: ':memory:',
    runsDir,
  });
  const internal = runtime as unknown as { handleBenchCommand(message: string): boolean };
  const messages: string[] = [];
  runtime.heart.submitSay = (_source, text) => { messages.push(text); };

  try {
    runtime.start();
    assert.equal(tuningDefaults.testBench.enabled, false);

    __setTuningOverride({ testBench: { enabled: false } });
    assert.equal(internal.handleBenchCommand('#test list'), true);
    assert.equal(runtime.benchRunner.active(), null);
    assert.match(messages.at(-1) ?? '', /默认关闭/);

    __setTuningOverride({ testBench: { enabled: true } });
    assert.equal(internal.handleBenchCommand('#test list'), true);
    assert.equal(runtime.benchRunner.active(), null);
    assert.match(messages.at(-1) ?? '', /可用测试/);
  } finally {
    __setTuningOverride(null);
    runtime.stop();
    rmSync(runsDir, { recursive: true, force: true });
  }
});
