import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BotRuntime, type BotRuntimeConfig } from '../../../../apps/minecraft-companion/src/bot/runtime.js';
import type { PlannerEvolutionRuntime } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerEvolutionRuntime.js';

function config(dataDir: string, mode: 'off' | 'observe'): BotRuntimeConfig {
  return {
    id: `evolution-${mode}`,
    dataDir,
    plannerEvolutionMode: mode,
    connection: {
      host: '127.0.0.1', port: 25565, username: `Evolution${mode}`, auth: 'offline',
      reconnect: { enabled: false, maxRetries: 0, baseDelay: 1, maxDelay: 1 },
    },
    llm: { apiKey: '', baseUrl: '', model: '' },
    personality: { name: `Evolution${mode}`, style: 'test', description: 'test', prompt: 'test' },
  };
}

test('FEAT-CROSS-20 · Evolution off 不装配运行时或创建专属持久化文件', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mineclaw-evolution-off-'));
  const runtime = new BotRuntime(config(dataDir, 'off'));
  try {
    await runtime.start();
    const internal = runtime as unknown as { plannerEvolution: PlannerEvolutionRuntime | null };
    assert.equal(internal.plannerEvolution, null);
    assert.equal(existsSync(join(dataDir, 'planner-evolution-evolution-off.db')), false);
    assert.equal(existsSync(join(dataDir, 'planner-execution-facts-evolution-off.jsonl')), false);
  } finally {
    await runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-20 · 显式 observe 仍装配 Planner Evolution', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mineclaw-evolution-observe-'));
  const runtime = new BotRuntime(config(dataDir, 'observe'));
  try {
    await runtime.start();
    await new Promise(resolve => setImmediate(resolve));
    const internal = runtime as unknown as { plannerEvolution: PlannerEvolutionRuntime | null };
    assert.ok(internal.plannerEvolution);
    assert.equal(existsSync(join(dataDir, 'planner-evolution-evolution-observe.db')), true);
  } finally {
    await runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
