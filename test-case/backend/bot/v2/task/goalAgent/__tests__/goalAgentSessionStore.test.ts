import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import {
  GoalAgentSessionStore,
  GoalAgentStateConflictError,
  GoalAgentTerminalSessionError,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { cloneGoalAgentState, createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2,
      sessionId: 'interaction-1',
      messageId: 'request-1',
      correlationId: 'correlation-1',
      conversationId: 'conversation-1',
      sequence: 1,
      emittedAt: '2026-08-20T00:00:00.000Z',
      idempotencyKey: 'request-1',
    },
    origin: 'player_message',
    originalText: 'make a pickaxe',
    requestText: 'make a pickaxe',
    requestKind: 'task',
    constraints: [],
  };
}

function initial() {
  return createGoalAgentState({
    sessionId: 'goal-1',
    interactionSessionId: 'interaction-1',
    request: request(),
    now: '2026-08-20T00:00:00.000Z',
  });
}

test('persists and restores one complete active checkpoint', () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const state = initial();
    store.create(state);
    state.context.timeline.push({
      sequence: 1, node: 'round', phase: 'running', kind: 'transition', summary: 'caller mutation',
      stateRevision: 0, occurredAt: state.updatedAt, evidenceRefs: [],
    });
    assert.deepEqual(store.getActive('goal-1')?.context.timeline, []);

    const next = cloneGoalAgentState(store.getActive('goal-1')!);
    next.revision = 1;
    next.phase = 'running';
    next.activeNode = 'round';
    next.updatedAt = '2026-08-20T00:00:01.000Z';
    next.context.timeline.push({
      sequence: 1,
      node: 'round',
      phase: 'running',
      kind: 'transition',
      summary: 'start planning',
      stateRevision: 1,
      occurredAt: next.updatedAt,
      evidenceRefs: [],
    });
    store.commit({ expectedRevision: 0, expectedEpoch: 1, state: next });
    assert.equal(store.getActive('goal-1')?.revision, 1);
    assert.equal(store.listActive().length, 1);
  } finally {
    store.close();
  }
});

test('CAS rejects stale revision and epoch', () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    store.create(initial());
    const stale = cloneGoalAgentState(store.getActive('goal-1')!);
    stale.revision = 1;
    stale.epoch = 2;
    assert.throws(
      () => store.commit({ expectedRevision: 0, expectedEpoch: 2, state: stale }),
      GoalAgentStateConflictError,
    );
  } finally {
    store.close();
  }
});

test('terminal checkpoint moves to tombstone and cannot be revived', () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const state = initial();
    store.create(state);
    const terminal = cloneGoalAgentState(state);
    terminal.revision = 1;
    terminal.phase = 'completed';
    terminal.activeNode = 'terminal';
    terminal.updatedAt = '2026-08-20T00:00:01.000Z';
    terminal.terminal = {
      outcome: 'completed',
      summary: 'done',
      completedAt: terminal.updatedAt,
      evidenceRefs: ['inventory:iron_pickaxe:1'],
    };
    store.commit({ expectedRevision: 0, expectedEpoch: 1, state: terminal });
    assert.equal(store.getActive('goal-1'), null);
    assert.equal(store.get('goal-1')?.terminal?.outcome, 'completed');
    assert.equal(store.hasTerminal('goal-1'), true);
    assert.throws(() => store.create(initial()), GoalAgentTerminalSessionError);
  } finally {
    store.close();
  }
});

test('session identity cannot change during a commit', () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    store.create(initial());
    const next = cloneGoalAgentState(store.getActive('goal-1')!);
    next.revision = 1;
    next.interactionSessionId = 'other-interaction';
    assert.throws(
      () => store.commit({ expectedRevision: 0, expectedEpoch: 1, state: next }),
      /session identity is immutable/,
    );
  } finally {
    store.close();
  }
});

test('BUG-CROSS-74 · one append-only event log derives messages and replays the latest checkpoint', () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    store.create(initial());
    const next = cloneGoalAgentState(store.getActive('goal-1')!);
    next.revision = 1;
    next.phase = 'running';
    next.activeNode = 'round';
    next.updatedAt = '2026-08-20T00:00:01.000Z';
    const messages = [
      { role: 'user', content: '[GoalAgent node=understand stateRevision=0 epoch=1]\nsearch target' },
      { role: 'assistant', content: '', tool_calls: [{
        id: 'target-1', type: 'function',
        function: { name: 'search_goal_targets', arguments: '{"query":"工作台"}' },
      }] },
      { role: 'tool', tool_call_id: 'target-1', content: '{"ok":true,"registryId":"minecraft:crafting_table"}' },
    ] as const;
    store.commit({ expectedRevision: 0, expectedEpoch: 1, state: next, messages });

    assert.deepEqual(store.deriveMessages('goal-1').slice(1), messages);
    assert.deepEqual(store.replay('goal-1'), store.getActive('goal-1'));
    assert.deepEqual(store.listSessionEvents('goal-1').map(event => event.type), [
      'input.accepted', 'message.appended', 'node.entered', 'state.checkpoint',
      'message.appended', 'message.appended', 'tool.called',
      'message.appended', 'tool.result', 'node.entered', 'state.checkpoint',
    ]);
  } finally {
    store.close();
  }
});

test('BUG-CROSS-74 · compaction checkpoints do not delete raw message events', () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    store.create(initial());
    store.appendMessage({
      sessionId: 'goal-1', node: 'round', stateRevision: 0, epoch: 1,
      message: { role: 'user', content: 'old round turn' },
    });
    store.recordCompaction({
      sessionId: 'goal-1', node: 'round', stateRevision: 0, epoch: 1,
      summary: '[GoalAgent compaction/v1]\n{"request":"make a pickaxe"}', omittedMessages: 1,
      throughMessageIndex: 1,
    });
    assert.equal(store.deriveMessages('goal-1').length, 2);
    assert.deepEqual(store.projectMessages('goal-1').messages, [{ role: 'user', content: 'old round turn' }]);
    assert.equal(store.listSessionEvents('goal-1').at(-1)?.type, 'compaction.checkpoint');
  } finally {
    store.close();
  }
});
