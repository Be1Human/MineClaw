import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { BenchRunner } from '../../../../../../apps/minecraft-companion/src/bot/v2/bench/benchRunner.js';
import { RunRecorder } from '../../../../../../apps/minecraft-companion/src/bot/v2/bench/runRecorder.js';
import type { TestCard } from '../../../../../../apps/minecraft-companion/src/bot/v2/bench/cards.js';

const actionCard: TestCard = { id: 'unit_action', tier: 'T0', title: 'unit', setup: ['/time set day'], launch: { type: 'action', action: 'move_to', args: { position: { x: 1, y: 64, z: 1 } } }, judge: { type: 'event_seen', event: 'atomic.move_to.end' }, timeoutMs: 1000 };

test('FEAT-CROSS-04：BenchRunner 摆场、提交原子、命中判据后归档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-bench-'));
  try {
    const bus = new EventBusV2();
    const setups: string[] = []; const submitted: string[] = [];
    const runner = new BenchRunner({
      bus, recorder: new RunRecorder(bus, dir), setup: command => { setups.push(command); },
      submitAction: req => { submitted.push(req.type); }, createTask: () => ({ id: 't' }), startTask: () => ({ ok: true }),
      judge: (card, events) => events.some(event => event.type === (card.judge.type === 'event_seen' ? card.judge.event : 'never')),
    });
    await runner.start(actionCard);
    assert.deepEqual(setups, ['/time set day']);
    assert.deepEqual(submitted, ['move_to']);
    bus.publish('atomic.move_to.end', 'info', { ok: true });
    assert.equal(runner.active(), null);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('FEAT-CROSS-04：abort 必定清理运行态并写入终态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-bench-'));
  try {
    const bus = new EventBusV2();
    const recorder = new RunRecorder(bus, dir);
    const runner = new BenchRunner({ bus, recorder, setup: () => {}, submitAction: () => {}, createTask: () => ({ id: 't' }), startTask: () => ({ ok: true }), judge: () => false });
    await runner.start(actionCard);
    assert.equal(runner.abort()?.verdict?.status, 'aborted');
    assert.equal(runner.active(), null);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});
