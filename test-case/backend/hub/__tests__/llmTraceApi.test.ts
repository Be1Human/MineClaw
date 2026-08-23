import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

const profileInput = (name: string) => ({
  name,
  personality: { description: 'trace API contract', style: 'calm' },
  server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
});

test('FEAT-WEBUI-19 · trace routes validate scope/query and expose summary, call detail and JSONL export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-llm-trace-api-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(root, 'data') });
  try {
    const profile = hub.profileStore.create(profileInput('TraceBot'));
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;

    const missing = await fetch(`${origin}/api/bots/missing/v2/llm-traces/sessions`);
    assert.equal(missing.status, 404);
    const inactive = await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/sessions`);
    assert.equal(inactive.status, 503);

    hub.botManager.getV2Snapshot = () => ({ running: true });
    hub.botManager.getLlmTraceSessions = (_botId, input) => ({
      sessions: [{
        sessionId: 'interaction-a', interactionSessionId: 'interaction-a', taskId: input.taskId,
        title: '给我一块石头', status: 'completed', firstSeq: 1, lastSeq: 8,
        startedAt: '2026-08-22T04:00:00.000Z', updatedAt: '2026-08-22T04:00:02.000Z',
        eventCount: 8, callCount: 2, agents: ['mainbrain', 'goalagent'], nodes: ['planner'],
      }],
      nextCursor: null,
      hasMore: false,
    });
    hub.botManager.getLlmTraceEvents = () => ({
      events: [{
        eventId: 'event-1', seq: 1, occurredAt: '2026-08-22T04:00:00.000Z',
        type: 'interaction.received', agent: 'mainbrain', payload: { message: '给我一块石头' }, payloadTruncated: false,
      }],
      hasMore: false,
      latestSeq: 1,
    });
    hub.botManager.getLlmTraceCall = (_botId, callId) => callId === 'call-a' ? ({
      callId, status: 'succeeded',
      requestEvent: {
        schema: 'mineclaw.llm-trace-event/v1', eventId: 'request-a', profileId: profile.id, seq: 2,
        occurredAt: '2026-08-22T04:00:00.000Z', type: 'llm.request.recorded', agent: 'mainbrain', payload: {},
      },
      terminalEvent: null,
      events: [],
      request: { messages: [{ role: 'user', content: '给我一块石头' }] }, response: null,
      context: { selected: [], omitted: [] }, tools: [],
      timing: { requestedAt: '2026-08-22T04:00:00.000Z', finishedAt: null, durationMs: null },
    }) : null;
    hub.botManager.exportLlmTraceSession = () => '{"seq":1}\n';

    const invalid = await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/events?limit=501`);
    assert.equal(invalid.status, 400);
    const sessions = await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/sessions?taskId=task-a`);
    assert.equal(sessions.status, 200);
    assert.equal((await sessions.json() as { sessions: { taskId?: string }[] }).sessions[0]?.taskId, 'task-a');
    const events = await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/events?sessionId=interaction-a&agent=mainbrain`);
    assert.equal(events.status, 200);
    assert.equal((await events.json() as { events: { eventId: string }[] }).events[0]?.eventId, 'event-1');
    const call = await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/calls/call-a`);
    assert.equal(call.status, 200);
    assert.equal((await call.json() as { call: { callId: string } }).call.callId, 'call-a');
    assert.equal((await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/calls/missing`)).status, 404);
    const exported = await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/export?sessionId=interaction-a`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') ?? '', /application\/x-ndjson/);
    assert.equal(await exported.text(), '{"seq":1}\n');
    assert.equal((await fetch(`${origin}/api/bots/${profile.id}/v2/llm-traces/export?sessionId=interaction-a&format=csv`)).status, 400);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
