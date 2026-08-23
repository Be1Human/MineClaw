import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { RunRecorder, laneOf } from '../../../../../../apps/minecraft-companion/src/bot/v2/bench/runRecorder.js';

describe('FEAT-CROSS-04 · RunRecorder', () => {
  test('旁路记录全事件、采样、判定，并按泳道读取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-runs-'));
    try {
      const bus = new EventBusV2();
      const recorder = new RunRecorder(bus, dir);
      recorder.start('run 1', 'walk_to_10');
      bus.publish('task.created', 'info', { id: 't1' });
      bus.publish('atomic.move_to.end', 'info', { ok: true });
      recorder.sample({ pos: { x: 10, y: 64, z: 0 }, food: 20 });
      const summary = recorder.stop({ status: 'pass' });

      assert.equal(summary?.verdict?.status, 'pass');
      const trace = recorder.trace('run 1');
      assert.equal(trace.find(item => item.type === 'task.created')?.lane, 'task');
      assert.equal(trace.find(item => item.type === 'atomic.move_to.end')?.lane, 'execution');
      assert.ok(trace.some(item => item.kind === 'sample'));
      assert.equal(recorder.list()[0]?.cardId, 'walk_to_10');
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });

  test('泳道映射稳定，达到大小上限后安全截断', () => {
    assert.equal(laneOf('goalagent.report'), 'decision');
    assert.equal(laneOf('strategy.gather'), 'strategy');
    assert.equal(laneOf('bot.death'), 'world');
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-runs-'));
    try {
      const bus = new EventBusV2();
      const recorder = new RunRecorder(bus, dir, 80);
      recorder.start('small', 'card');
      bus.publish('atomic.move_to.end', 'info', { long: 'x'.repeat(200) });
      assert.equal(recorder.current()?.truncated, true);
      recorder.stop({ status: 'fail', reason: 'trace_truncated' });
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });

  test('失败和超时生成可携带归档：trace、卡片快照与可粘贴复现命令齐全', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-runs-'));
    try {
      const bus = new EventBusV2();
      const recorder = new RunRecorder(bus, dir);
      const card = {
        id: 'walk_to_10', tier: 'T0' as const, title: 'walk', setup: ['/time set day', '/tp @s 0 64 0'],
        launch: { type: 'action' as const, action: 'move_to', args: { position: { x: 10, y: 64, z: 0 } } },
        judge: { type: 'event_seen' as const, event: 'atomic.move_to.end' }, timeoutMs: 1_000,
      };
      recorder.start('failed run', card.id);
      bus.publish('atomic.move_to.end', 'critical', { reason: 'no_path' });
      const summary = recorder.stop({ status: 'timeout', reason: 'timeout:1000' });
      const archive = recorder.archiveFailure(summary!, card);

      assert.ok(archive);
      assert.ok(existsSync(join(archive!, 'trace.jsonl')));
      assert.ok(existsSync(join(archive!, 'card.json')));
      assert.match(readFileSync(join(archive!, 'repro.txt'), 'utf8'), /#test walk_to_10/);
      assert.match(readFileSync(join(archive!, 'repro.txt'), 'utf8'), /\/tp @s 0 64 0/);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
