/**
 * Unit tests for recoveryPlanner.ts · planRecovery() pure function
 * Integration tests for decide() tool_broken handling (via supervisorDecide.ts)
 *
 * Test runner: node:test + node:assert/strict
 * Run: npm run test:v2 (from apps/minecraft-companion/)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planRecovery, type RecoveryVerdict } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/recoveryPlanner.js';
import {
  decide,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorState,
  type SupervisorConfig,
  type Action,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorDecide.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { Diagnosis } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisor.js';

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    suspendedByDanger: new Set<string>(),
    ongoingRecoveries: new Map<string, string>(),
    recentDiagnoses: [],
    lastProgressTick: new Map<string, number>(),
    recoveryAttempts: new Map<string, number>(),
    narrationCooldowns: new Map<string, number>(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'farm',
    state: 'running',
    priority: 40,
    preconditions: [],
    params: {},
    createdAt: Date.now(),
    lastActiveTick: 0,
    ...overrides,
  };
}

function makeDiag(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    taskId: 'task-1',
    category: 'resource_missing',
    detail: 'tool_broken:wooden_hoe',
    ...overrides,
  };
}

function makeEvent(
  type: string,
  level: BusEvent['level'],
  payload: Record<string, unknown> = {},
): BusEvent {
  return {
    id: `evt-${Date.now()}-${Math.random()}`,
    type,
    level,
    timestamp: Date.now(),
    payload,
  };
}

function hasKind(actions: Action[], kind: Action['kind']): boolean {
  return actions.some(a => a.kind === kind);
}

function getBusPublish(actions: Action[], eventType: string): Action[] {
  return actions.filter(
    a => a.kind === 'bus.publish' && (a as Extract<Action, { kind: 'bus.publish' }>).eventType === eventType,
  );
}

const cfg: Readonly<SupervisorConfig> = DEFAULT_SUPERVISOR_CONFIG;

// ──────────────────────────────────────────────────────────────────
// planRecovery() unit tests
// ──────────────────────────────────────────────────────────────────

describe('planRecovery()', () => {
  it('case 1 · recoveryAttempts >= RECOVERY_MAX_ATTEMPTS → abort', () => {
    const task = makeTask({ id: 'task-maxed' });
    const diag = makeDiag({ taskId: 'task-maxed', category: 'resource_missing' });
    const attempts = new Map([['task-maxed', cfg.RECOVERY_MAX_ATTEMPTS]]);

    const verdict = planRecovery(diag, task, null, cfg, attempts);

    assert.equal(verdict.kind, 'abort', 'should abort when max attempts reached');
    assert.equal((verdict as Extract<RecoveryVerdict, { kind: 'abort' }>).reason, 'max_attempts_reached');
  });

  it('case 2 · category=stuck → suggest reset_pathfinder subtask', () => {
    const task = makeTask({ id: 'task-stuck' });
    const diag = makeDiag({ taskId: 'task-stuck', category: 'stuck', detail: 'no_progress' });
    const attempts = new Map<string, number>(); // 0 attempts

    const verdict = planRecovery(diag, task, null, cfg, attempts);

    assert.equal(verdict.kind, 'subtask', 'stuck → subtask');
    const sub = verdict as Extract<RecoveryVerdict, { kind: 'subtask' }>;
    assert.equal(sub.suggestion.kind, 'reset_pathfinder');
    assert.equal((sub.suggestion.params as Record<string, unknown>).taskId, 'task-stuck');
  });

  it('case 3 · category=resource_missing + task.params.hoeName → suggest craft_item', () => {
    const task = makeTask({ id: 'task-farm', params: { hoeName: 'wooden_hoe' } });
    const diag = makeDiag({ taskId: 'task-farm', category: 'resource_missing' });
    const attempts = new Map<string, number>();

    const verdict = planRecovery(diag, task, null, cfg, attempts);

    assert.equal(verdict.kind, 'subtask', 'resource_missing + hoeName → subtask');
    const sub = verdict as Extract<RecoveryVerdict, { kind: 'subtask' }>;
    assert.equal(sub.suggestion.kind, 'craft_item');
    const params = sub.suggestion.params as Record<string, unknown>;
    assert.equal(params.item, 'wooden_hoe');
    assert.ok(Array.isArray(params.recipe), 'recipe should be an array');
  });

  it('case 4 · category=resource_missing + no hoeName → ask_master', () => {
    const task = makeTask({ id: 'task-nomatch', params: {} });
    const diag = makeDiag({ taskId: 'task-nomatch', category: 'resource_missing' });
    const attempts = new Map<string, number>();

    const verdict = planRecovery(diag, task, null, cfg, attempts);

    assert.equal(verdict.kind, 'ask_master', 'resource_missing without hoeName → ask_master');
    const v = verdict as Extract<RecoveryVerdict, { kind: 'ask_master' }>;
    assert.equal(v.reason, 'cannot_auto_recover');
  });

  it('case 5 · category=unknown → ask_master (unknown_category)', () => {
    const task = makeTask({ id: 'task-unk', params: {} });
    const diag = makeDiag({ taskId: 'task-unk', category: 'unknown', detail: 'something_weird' });
    const attempts = new Map<string, number>();

    const verdict = planRecovery(diag, task, null, cfg, attempts);

    // unknown + no hoeName → ask_master
    assert.equal(verdict.kind, 'ask_master');
    const v = verdict as Extract<RecoveryVerdict, { kind: 'ask_master' }>;
    assert.equal(v.reason, 'cannot_auto_recover');
  });

  it('case 5b · category=unknown with hoeName → suggest craft_item (unknown treated like resource_missing)', () => {
    const task = makeTask({ id: 'task-unk2', params: { hoeName: 'stone_hoe' } });
    const diag = makeDiag({ taskId: 'task-unk2', category: 'unknown', detail: 'tool_broken:stone_hoe' });
    const attempts = new Map<string, number>();

    const verdict = planRecovery(diag, task, null, cfg, attempts);

    assert.equal(verdict.kind, 'subtask', 'unknown + hoeName → craft_item subtask');
    const sub = verdict as Extract<RecoveryVerdict, { kind: 'subtask' }>;
    assert.equal(sub.suggestion.kind, 'craft_item');
    assert.equal((sub.suggestion.params as Record<string, unknown>).item, 'stone_hoe');
  });
});

// ──────────────────────────────────────────────────────────────────
// Integration: decide() + tool_broken event
// ──────────────────────────────────────────────────────────────────

describe('decide() · tool_broken integration', () => {
  it('case 6 · tool_broken + running farm task with hoeName → l6.inject action', () => {
    const state = makeState();
    const task = makeTask({
      id: 'task-farm-2',
      kind: 'farm',
      state: 'running',
      params: { hoeName: 'wooden_hoe' },
    });
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_hoe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      null,
      cfg,
      { running: [task], paused: [] },
    );

    assert.ok(hasKind(actions, 'l6.inject'), 'should produce l6.inject action');
    const injectAction = actions.find(a => a.kind === 'l6.inject') as Extract<Action, { kind: 'l6.inject' }>;
    assert.equal(injectAction.parentTaskId, 'task-farm-2');
    assert.equal(injectAction.suggestion.kind, 'craft_item');

    const recoveryStarted = getBusPublish(actions, 'supervisor.recovery_started');
    assert.equal(recoveryStarted.length, 1, 'should publish supervisor.recovery_started');

    assert.ok(hasKind(actions, 'state.push_diagnosis'), 'should push diagnosis');
  });

  it('case 7 · tool_broken + no running task → []', () => {
    const state = makeState();
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_hoe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      null,
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'no running task → []');
  });

  it('case 8 · tool_broken + already ongoingRecovery → []', () => {
    const task = makeTask({ id: 'task-farm-3', params: { hoeName: 'wooden_hoe' } });
    const state = makeState({
      ongoingRecoveries: new Map([['task-farm-3', 'subtask-99']]),
    });
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_hoe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      null,
      cfg,
      { running: [task], paused: [] },
    );

    assert.deepEqual(actions, [], 'already recovering → []');
  });

  it('case 9 · tool_broken + recoveryAttempts maxed out → l6.fail + bus.publish(supervisor.escalate)', () => {
    const task = makeTask({ id: 'task-maxed2', params: { hoeName: 'wooden_hoe' } });
    const state = makeState({
      recoveryAttempts: new Map([['task-maxed2', cfg.RECOVERY_MAX_ATTEMPTS]]),
    });
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_hoe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      null,
      cfg,
      { running: [task], paused: [] },
    );

    assert.ok(hasKind(actions, 'l6.fail'), 'maxed attempts → l6.fail');
    const escalate = getBusPublish(actions, 'supervisor.escalate');
    assert.equal(escalate.length, 1, 'should publish supervisor.escalate');

    const failAction = actions.find(a => a.kind === 'l6.fail') as Extract<Action, { kind: 'l6.fail' }>;
    assert.equal(failAction.taskId, 'task-maxed2');
    assert.equal(failAction.reason, 'max_attempts_reached');
  });

  it('case 10 · tool_broken + tool does NOT match task hoeName → []', () => {
    const task = makeTask({
      id: 'task-mismatch',
      params: { hoeName: 'wooden_hoe' },
    });
    const state = makeState();
    // tool_broken fires for iron_pickaxe, but task only cares about wooden_hoe → skip
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'iron_pickaxe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      null,
      cfg,
      { running: [task], paused: [] },
    );

    assert.deepEqual(actions, [], 'broken tool not relevant to task → skip');
  });
});
