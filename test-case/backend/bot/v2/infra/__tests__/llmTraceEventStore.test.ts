import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openSqliteDatabase } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/sqliteDatabase.js';
import {
  LlmTraceCapacityError,
  LlmTraceCorruptionError,
  LlmTraceDuplicateEventError,
  LlmTraceEventStore,
  type LlmTraceEventInputV1,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/llmTrace/index.js';

function input(overrides: Partial<LlmTraceEventInputV1> = {}): LlmTraceEventInputV1 {
  return {
    occurredAt: '2026-08-22T04:00:00.000Z',
    type: 'llm.request.recorded',
    callId: 'call-1',
    interactionSessionId: 'interaction-1',
    agent: 'mainbrain',
    payload: {
      request: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '给我一块石头' }],
      },
    },
    ...overrides,
  };
}

test('appends immutable events with profile-local continuous seq and deep clones payload', () => {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-a' });
  try {
    const original = input({ eventId: 'event-1' });
    const first = store.append(original);
    original.payload.request = { changed: true };
    const second = store.append(input({
      eventId: 'event-2',
      type: 'llm.response.recorded',
      payload: { content: '好的' },
    }));

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(first.profileId, 'profile-a');
    assert.equal(store.listEvents().events.length, 2);
    assert.deepEqual(store.getByEventId('event-1')?.payload, {
      request: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '给我一块石头' }],
      },
    });
  } finally {
    store.close();
  }
});

test('same eventId is idempotent only when immutable event content matches', () => {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-a' });
  try {
    const event = input({ eventId: 'stable-event' });
    assert.equal(store.append(event).seq, 1);
    assert.equal(store.append(event).seq, 1);
    assert.throws(
      () => store.append({ ...event, payload: { request: { changed: true } } }),
      LlmTraceDuplicateEventError,
    );
    assert.equal(store.listEvents().events.length, 1);
  } finally {
    store.close();
  }
});

test('persists WAL history, restores next seq, and reports unclosed requests after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-llm-trace-'));
  const filename = join(root, 'trace.db');
  try {
    const first = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    first.append(input({ eventId: 'request-1', callId: 'open-call' }));
    first.close();

    const restored = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    assert.deepEqual(restored.listOpenCalls().map(call => call.callId), ['open-call']);
    const terminal = restored.append(input({
      eventId: 'failure-1',
      callId: 'open-call',
      type: 'llm.call.failed',
      payload: { category: 'timeout' },
    }));
    assert.equal(terminal.seq, 2);
    assert.deepEqual(restored.listOpenCalls(), []);
    restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('profile database ownership prevents accidental cross-profile reuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-llm-trace-profile-'));
  const filename = join(root, 'trace.db');
  try {
    const first = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    first.close();
    assert.throws(
      () => new LlmTraceEventStore({ filename, profileId: 'profile-b' }),
      LlmTraceCorruptionError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup fails loudly on payload corruption and seq metadata mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-llm-trace-corrupt-'));
  const filename = join(root, 'trace.db');
  try {
    const store = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    store.append(input({ eventId: 'event-1' }));
    store.close();

    const db = openSqliteDatabase(filename);
    db.prepare("UPDATE llm_trace_events SET payload_json = 'not-json' WHERE event_id = ?").run('event-1');
    db.close();
    assert.throws(
      () => new LlmTraceEventStore({ filename, profileId: 'profile-a' }),
      LlmTraceCorruptionError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archives only a complete selected session while preserving canonical seq integrity', () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-llm-trace-archive-'));
  const filename = join(root, 'trace.db');
  try {
    const store = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    store.append(input({ eventId: 'a-1', callId: 'a-call', interactionSessionId: 'a' }));
    store.append(input({ eventId: 'b-1', callId: 'b-call', interactionSessionId: 'b' }));
    store.append(input({ eventId: 'a-2', callId: 'a-call', interactionSessionId: 'a', type: 'llm.response.recorded' }));
    assert.deepEqual(store.archiveSession({ interactionSessionId: 'a' }), {
      archivedEvents: 2,
      firstSeq: 1,
      lastSeq: 3,
    });
    assert.deepEqual(store.listEvents().events.map(event => event.eventId), ['b-1']);
    assert.deepEqual(
      store.listEvents({ includeArchived: true }).events.map(event => event.eventId),
      ['a-1', 'b-1', 'a-2'],
    );
    store.validateIntegrity();
    store.close();

    const restored = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    assert.equal(restored.append(input({ eventId: 'b-2', interactionSessionId: 'b' })).seq, 4);
    restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforces per-event and database capacity before append', () => {
  const payloadStore = new LlmTraceEventStore({
    filename: ':memory:',
    profileId: 'profile-a',
    maxPayloadBytes: 24,
  });
  try {
    assert.throws(() => payloadStore.append(input()), LlmTraceCapacityError);
    assert.equal(payloadStore.listEvents().events.length, 0);
  } finally {
    payloadStore.close();
  }

  const databaseStore = new LlmTraceEventStore({
    filename: ':memory:',
    profileId: 'profile-a',
    maxDatabaseBytes: 1,
  });
  try {
    assert.throws(() => databaseStore.append(input()), LlmTraceCapacityError);
    assert.equal(databaseStore.listEvents().events.length, 0);
  } finally {
    databaseStore.close();
  }
});

test('paginates and filters events without duplicate or skipped seq', () => {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-a' });
  try {
    for (let index = 1; index <= 12; index += 1) {
      store.append(input({
        eventId: `event-${index}`,
        callId: `call-${index}`,
        agent: index % 2 === 0 ? 'goalagent' : 'mainbrain',
      }));
    }
    const first = store.listEvents({ limit: 5 });
    const second = store.listEvents({ afterSeq: first.events.at(-1)!.seq, limit: 5 });
    const third = store.listEvents({ afterSeq: second.events.at(-1)!.seq, limit: 5 });
    assert.deepEqual(
      [...first.events, ...second.events, ...third.events].map(event => event.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    assert.equal(first.hasMore, true);
    assert.equal(third.hasMore, false);
    assert.deepEqual(
      store.listEvents({ agent: 'goalagent' }).events.map(event => event.seq),
      [2, 4, 6, 8, 10, 12],
    );
  } finally {
    store.close();
  }
});
