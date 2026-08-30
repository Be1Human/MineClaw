import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatMemoryService, type MemoryConsolidationOperation } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import { ChatMemoryConsolidator, type MemoryFactExtractor } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemoryConsolidation.js';
import { MemoryConsolidationScheduler } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memoryConsolidationScheduler.js';
import { tuningDefaults } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';

async function withMemory(run: (memory: ChatMemoryService) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-memory-scheduler-'));
  const memory = new ChatMemoryService({ dbPath: join(dir, 'memory.db'), profileId: 'p', autoCapture: false });
  try { await run(memory); }
  finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
}

function config(intervalMs = 300_000) {
  return { ...tuningDefaults.memoryConsolidation, intervalMs };
}

describe('MemoryConsolidationScheduler', () => {
  test('默认周期为五分钟，下一次调度热读取新 interval', async () => withMemory(async memory => {
    let activeConfig = config();
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const scheduler = new MemoryConsolidationScheduler(
      new ChatMemoryConsolidator(memory, { async extract() { return []; } }),
      {
        getConfig: () => activeConfig,
        setTimer: (callback, delay) => { callbacks.push(callback); delays.push(delay); return callback; },
        clearTimer: () => undefined,
      },
    );
    scheduler.start();
    assert.equal(delays[0], 300_000);
    activeConfig = config(1_234);
    callbacks.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delays[1], 1_234);
    scheduler.stop();
  }));

  test('无新 owner 消息时周期执行不调用提取器', async () => withMemory(async memory => {
    let calls = 0;
    const scheduler = new MemoryConsolidationScheduler(
      new ChatMemoryConsolidator(memory, { async extract() { calls += 1; return []; } }),
      { getConfig: () => config(), setTimer: () => ({}), clearTimer: () => undefined },
    );
    scheduler.start();
    assert.equal((await scheduler.runNow()).status, 'idle');
    assert.equal(calls, 0);
    scheduler.stop();
  }));

  test('慢请求共用同一 inFlight，不会并发重入', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-one', sessionId: 's', role: 'owner', content: '我喜欢吃鱼', timestamp: 1 });
    let calls = 0;
    let release: ((operations: MemoryConsolidationOperation[]) => void) | undefined;
    const extractor: MemoryFactExtractor = {
      extract: async () => {
        calls += 1;
        return new Promise(resolve => { release = resolve; });
      },
    };
    const scheduler = new MemoryConsolidationScheduler(
      new ChatMemoryConsolidator(memory, extractor, () => 'run-single-flight'),
      { getConfig: () => config(), setTimer: () => ({}), clearTimer: () => undefined },
    );
    scheduler.start();
    const first = scheduler.runNow();
    const second = scheduler.runNow();
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    release?.([{ action: 'add', kind: 'preference', text: '我喜欢吃鱼', sourceMessageIds: ['m-one'] }]);
    assert.equal((await first).status, 'committed');
    scheduler.stop();
  }));

  test('stop 会 Abort 且 generation 门阻止迟到模型结果写库', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-late', sessionId: 's', role: 'owner', content: '我喜欢安静', timestamp: 1 });
    let observedSignal: AbortSignal | undefined;
    let release: ((operations: MemoryConsolidationOperation[]) => void) | undefined;
    const extractor: MemoryFactExtractor = {
      extract: async input => {
        observedSignal = input.signal;
        return new Promise(resolve => { release = resolve; });
      },
    };
    const scheduler = new MemoryConsolidationScheduler(
      new ChatMemoryConsolidator(memory, extractor, () => 'run-late'),
      { getConfig: () => config(), setTimer: () => ({}), clearTimer: () => undefined },
    );
    scheduler.start();
    const inFlight = scheduler.runNow();
    scheduler.stop();
    assert.equal(observedSignal?.aborted, true);
    release?.([{ action: 'add', kind: 'preference', text: '我喜欢安静', sourceMessageIds: ['m-late'] }]);
    const result = await inFlight;
    assert.equal(result.status, 'retry');
    assert.equal(memory.getFacts().length, 0);
    assert.equal(memory.pendingOwnerMessageCount(), 1);
  }));

  test('enabled=false 保留 Scheduler 但跳过模型和账本', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-disabled', sessionId: 's', role: 'owner', content: '我喜欢绿色', timestamp: 1 });
    let calls = 0;
    const scheduler = new MemoryConsolidationScheduler(
      new ChatMemoryConsolidator(memory, { async extract() { calls += 1; return []; } }),
      { getConfig: () => ({ ...config(), enabled: false }), setTimer: () => ({}), clearTimer: () => undefined },
    );
    scheduler.start();
    assert.equal((await scheduler.runNow()).status, 'idle');
    assert.equal(calls, 0);
    assert.equal(memory.pendingOwnerMessageCount(), 1);
    scheduler.stop();
  }));
});
