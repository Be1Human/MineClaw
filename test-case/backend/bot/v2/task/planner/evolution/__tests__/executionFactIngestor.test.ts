import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTION_FACT_SCHEMA_V1,
  type ExecutionFactEnvelopeV1,
} from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';
import { EpisodeLedger } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import {
  ExecutionFactIngestor,
  type ExecutionFactSource,
} from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/executionFactIngestor.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ExecutionFactIngestor + EpisodeLedger', () => {
  test('乱序 terminal 等待缺口补齐后才 finalize', () => {
    const ledger = new EpisodeLedger(':memory:');
    const ingestor = new ExecutionFactIngestor(ledger);

    assert.deepEqual(ingestor.accept(fact(1, 'execution.session.started')), {
      kind: 'accepted', state: 'open', finalizedNow: false, knownEventType: true,
    });
    assert.deepEqual(ingestor.accept(terminal(3, 'succeeded')), {
      kind: 'accepted', state: 'awaiting_facts', finalizedNow: false, knownEventType: true,
    });

    const waiting = ledger.getEpisode('session-1');
    assert.equal(waiting?.state, 'awaiting_facts');
    assert.equal(waiting?.lastContiguousSequence, 1);
    assert.equal(waiting?.terminalSequence, 3);

    assert.deepEqual(ingestor.accept(fact(2, 'execution.action.completed')), {
      kind: 'accepted', state: 'finalized', finalizedNow: true, knownEventType: true,
    });
    const finalized = ledger.getEpisode('session-1');
    assert.equal(finalized?.state, 'finalized');
    assert.equal(finalized?.outcome, 'succeeded');
    assert.deepEqual(finalized?.facts.map(item => item.sequence), [1, 2, 3]);
    ledger.close();
  });

  test('重复 event 幂等，sequence 冲突进入隔离区', () => {
    const ledger = new EpisodeLedger(':memory:');
    const ingestor = new ExecutionFactIngestor(ledger);
    const original = fact(1, 'execution.session.started');

    assert.equal(ingestor.accept(original).kind, 'accepted');
    assert.deepEqual(ingestor.accept({ ...original }), { kind: 'duplicate' });

    const conflict = { ...fact(1, 'execution.state.changed'), eventId: 'event-conflict' };
    assert.deepEqual(ingestor.accept(conflict), { kind: 'quarantined', reason: 'sequence_conflict' });
    assert.equal(ledger.getEpisode('session-1')?.facts.length, 1);
    assert.equal(ledger.listQuarantine()[0]?.reason, 'sequence_conflict');
    ledger.close();
  });

  test('未知 schema 与非法 envelope 不污染 Episode', () => {
    const ledger = new EpisodeLedger(':memory:');
    const ingestor = new ExecutionFactIngestor(ledger);

    assert.deepEqual(
      ingestor.accept({ ...fact(1, 'execution.session.started'), schema: 'mineclaw.execution-fact/v2' }),
      { kind: 'quarantined', reason: 'unsupported_schema:mineclaw.execution-fact/v2' },
    );
    assert.deepEqual(
      ingestor.accept({ ...fact(1, 'execution.session.started'), sequence: 0 }),
      { kind: 'quarantined', reason: 'invalid:sequence_invalid' },
    );
    assert.equal(ledger.getEpisode('session-1'), null);
    assert.equal(ledger.listQuarantine().length, 2);
    ledger.close();
  });

  test('同 major 未知事件保留为 opaque fact，不产生终态语义', () => {
    const ledger = new EpisodeLedger(':memory:');
    const ingestor = new ExecutionFactIngestor(ledger);

    assert.deepEqual(ingestor.accept(fact(1, 'execution.future.telemetry')), {
      kind: 'accepted', state: 'open', finalizedNow: false, knownEventType: false,
    });
    assert.equal(ledger.getEpisode('session-1')?.facts[0]?.eventType, 'execution.future.telemetry');
    ledger.close();
  });

  test('terminal 后只接受 late_result_ignored 审计事实', () => {
    const ledger = new EpisodeLedger(':memory:');
    const ingestor = new ExecutionFactIngestor(ledger);
    ingestor.accept(fact(1, 'execution.session.started'));
    ingestor.accept(terminal(2, 'cancelled'));

    assert.deepEqual(ingestor.accept(fact(3, 'execution.state.changed')), {
      kind: 'quarantined', reason: 'event_after_terminal',
    });
    assert.deepEqual(ingestor.accept(fact(3, 'execution.late_result_ignored')), {
      kind: 'accepted', state: 'finalized', finalizedNow: false, knownEventType: true,
    });
    assert.equal(ledger.getEpisode('session-1')?.outcome, 'cancelled');
    assert.equal(ledger.getEpisode('session-1')?.facts.length, 3);
    ledger.close();
  });

  test('游标 catch-up 跨批落盘，重启后从已提交 cursor 继续', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-ledger-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'episodes.db');
    const source = new PagedSource([
      [fact(1, 'execution.session.started'), fact(2, 'execution.action.completed')],
      [terminal(3, 'succeeded')],
    ]);

    const firstLedger = new EpisodeLedger(dbPath);
    const first = await new ExecutionFactIngestor(firstLedger).catchUp(source, {
      consumerId: 'test-consumer', batchSize: 2,
    });
    assert.equal(first.accepted, 3);
    assert.equal(first.finalized, 1);
    assert.equal(first.cursor, '3');
    firstLedger.close();

    const reopened = new EpisodeLedger(dbPath);
    assert.equal(reopened.getCursor('test-consumer'), '3');
    assert.equal(reopened.getEpisode('session-1')?.state, 'finalized');
    const second = await new ExecutionFactIngestor(reopened).catchUp(source, {
      consumerId: 'test-consumer', batchSize: 2,
    });
    assert.equal(second.seen, 0);
    assert.equal(source.cursors.at(-1), '3');
    reopened.close();
  });
});

function fact(sequence: number, eventType: string): ExecutionFactEnvelopeV1 {
  return {
    schema: EXECUTION_FACT_SCHEMA_V1,
    eventId: `event-${sequence}`,
    eventType,
    sessionId: 'session-1',
    runId: 'run-1',
    planRunId: 'plan-1',
    planRevision: 1,
    nodeId: 'node-1',
    sequence,
    occurredAt: new Date(Date.UTC(2026, 7, 2, 0, 0, sequence)).toISOString(),
    codeRevision: 'code-a',
    configRevision: 'config-a',
    correlationId: 'corr-1',
    payload: { sequence },
  };
}

function terminal(
  sequence: number,
  outcome: 'succeeded' | 'failed' | 'cancelled',
): ExecutionFactEnvelopeV1 {
  return {
    ...fact(sequence, 'execution.session.terminal'),
    payload: {
      outcome,
      handoff: outcome === 'failed' ? 'graph_replan_required' : 'none',
      verdict: { ok: outcome === 'succeeded', detail: `terminal:${outcome}` },
    },
  };
}

class PagedSource implements ExecutionFactSource {
  readonly cursors: Array<string | null> = [];
  private readonly flattened: unknown[];

  constructor(pages: unknown[][]) {
    this.flattened = pages.flat();
  }

  async readAfter(cursor: string | null, limit: number): Promise<{ facts: unknown[]; nextCursor: string | null }> {
    this.cursors.push(cursor);
    const offset = cursor == null ? 0 : Number(cursor);
    const facts = this.flattened.slice(offset, offset + limit);
    const nextOffset = offset + facts.length;
    return {
      facts,
      nextCursor: facts.length > 0 ? String(nextOffset) : null,
    };
  }
}
