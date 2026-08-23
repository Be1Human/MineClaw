import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionFactLog, type ExecutionFactContext } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionFactLog.js';
import { parseExecutionFactV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';

test('BUG-CROSS-47 · fact log persists, replays and passes FEAT-CROSS-12 consumer contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-execution-facts-'));
  const path = join(dir, 'facts.jsonl');
  const context: ExecutionFactContext = {
    sessionId: 'leaf-1', runId: 'run-1', planRunId: 'plan-1', planRevision: 1,
    nodeId: 'node-1', correlationId: 'corr-1',
  };
  let wakeups = 0;
  let eventSeq = 0;
  try {
    const first = new ExecutionFactLog({
      filePath: path,
      codeRevision: 'abc123-dirty',
      configRevision: 'cfg-1',
      now: () => new Date('2026-08-02T00:00:00.000Z'),
      eventId: () => `event-${++eventSeq}`,
    });
    first.subscribeWakeup(() => { wakeups += 1; });
    first.append(context, 'execution.session.started', { goalText: '做铁镐' });
    first.append(context, 'execution.state.changed', { from: 'accepted', to: 'deciding' });
    assert.equal(wakeups, 2);

    const page1 = await first.readAfter(null, 1);
    assert.equal(page1.facts.length, 1);
    assert.equal(page1.nextCursor, '1');
    const page2 = await first.readAfter(page1.nextCursor, 10);
    assert.equal(page2.facts.length, 1);
    assert.equal(page2.nextCursor, '2', 'tail cursor must remain durable for the next wakeup');

    const reloaded = new ExecutionFactLog({
      filePath: path,
      codeRevision: 'abc123-dirty',
      configRevision: 'cfg-1',
      now: () => new Date('2026-08-02T00:00:01.000Z'),
      eventId: () => `event-${++eventSeq}`,
    });
    reloaded.append(context, 'execution.session.terminal', {
      outcome: 'succeeded',
      handoff: 'none',
      verdict: { ok: true, detail: '背包 iron_pickaxe 1/1' },
    });
    assert.deepEqual(reloaded.all().map(fact => fact.sequence), [1, 2, 3]);
    for (const fact of reloaded.all()) {
      const parsed = parseExecutionFactV1(fact);
      assert.equal(parsed.kind, 'valid');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
