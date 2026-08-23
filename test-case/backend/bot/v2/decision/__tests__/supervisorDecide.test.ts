/**
 * Unit tests for supervisorDecide.ts · decide() pure function
 *
 * Test runner: node:test + node:assert/strict
 * Run: npm run test:v2 (from apps/minecraft-companion/)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decide,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorState,
  type SupervisorConfig,
  type Action,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorDecide.js';
import type { BusEvent, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

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

/** Build a BusEvent with required fields */
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

function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: null,
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'follow_owner',
    state: 'running',
    priority: 40,
    preconditions: [],
    params: {},
    createdAt: Date.now(),
    lastActiveTick: 0,
    ...overrides,
  };
}

/** Extract all action kinds from result */
function kinds(actions: Action[]): string[] {
  return actions.map(a => a.kind);
}

/** Check that a kind appears in the actions */
function hasKind(actions: Action[], kind: Action['kind']): boolean {
  return actions.some(a => a.kind === kind);
}

/** Get all bus.publish actions filtered by eventType */
function getBusPublish(actions: Action[], eventType: string): Action[] {
  return actions.filter(
    a => a.kind === 'bus.publish' && (a as Extract<Action, { kind: 'bus.publish' }>).eventType === eventType,
  );
}

const cfg: Readonly<SupervisorConfig> = DEFAULT_SUPERVISOR_CONFIG;

// ──────────────────────────────────────────────────────────────────
// under_attack
// ──────────────────────────────────────────────────────────────────

describe('under_attack', () => {
  const attackEvent = makeEvent('under_attack', 'critical');

  it('case 1 · has running task + health normal → pause + add_suspended + say + bus.publish', () => {
    const state = makeState();
    const task = makeTask({ id: 'task-A', state: 'running' });
    const world = makeWorld(); // health = 20, well above threshold

    const actions = decide(
      { kind: 'event', event: attackEvent },
      state,
      world,
      cfg,
      { running: [task], paused: [] },
    );

    // Must emit all 4 actions
    assert.ok(actions.length >= 4, `Expected ≥4 actions, got ${actions.length}: ${JSON.stringify(kinds(actions))}`);
    assert.ok(hasKind(actions, 'l6.pause'), 'should include l6.pause');
    assert.ok(hasKind(actions, 'state.add_suspended'), 'should include state.add_suspended');
    assert.ok(hasKind(actions, 'hb.submitSay'), 'should include hb.submitSay');
    assert.ok(hasKind(actions, 'bus.publish'), 'should include bus.publish');

    // Verify taskId is correct in l6.pause
    const pauseAction = actions.find(a => a.kind === 'l6.pause') as Extract<Action, { kind: 'l6.pause' }>;
    assert.equal(pauseAction.taskId, 'task-A');

    // Verify bus.publish eventType
    const published = getBusPublish(actions, 'supervisor.task_suspended_by_danger');
    assert.equal(published.length, 1, 'should publish supervisor.task_suspended_by_danger');
  });

  it('case 2 · no running tasks → returns []', () => {
    const state = makeState();
    const world = makeWorld();

    const actions = decide(
      { kind: 'event', event: attackEvent },
      state,
      world,
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'no running tasks should yield no actions');
  });

  it('case 3 · running task already in suspendedByDanger → returns []', () => {
    const task = makeTask({ id: 'task-B', state: 'running' });
    const state = makeState({
      suspendedByDanger: new Set(['task-B']),
    });
    const world = makeWorld();

    const actions = decide(
      { kind: 'event', event: attackEvent },
      state,
      world,
      cfg,
      { running: [task], paused: [] },
    );

    assert.deepEqual(actions, [], 'already suspended task should yield no actions (idempotent)');
  });

  it('case 4 · health ≤ HEALTH_CRITICAL_THRESHOLD · still pauses task (emergency path uses same actions)', () => {
    const state = makeState();
    // Health at critical threshold (≤ 6)
    const world = makeWorld({
      self: {
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        pitch: 0,
        health: cfg.HEALTH_CRITICAL_THRESHOLD,
        maxHealth: 20,
        food: 10,
        isOnGround: true,
      },
    });
    const task = makeTask({ id: 'task-C', state: 'running' });

    const actions = decide(
      { kind: 'event', event: attackEvent },
      state,
      world,
      cfg,
      { running: [task], paused: [] },
    );

    // Even at critical health, the task is paused (emergency or not, the core action fires)
    assert.ok(hasKind(actions, 'l6.pause'), 'critical health: task should still be paused');
    assert.ok(hasKind(actions, 'state.add_suspended'), 'critical health: state.add_suspended should fire');
    assert.ok(hasKind(actions, 'bus.publish'), 'critical health: bus.publish should fire');
  });

  it('case 5 · multiple running tasks · only first task is paused', () => {
    const state = makeState();
    const world = makeWorld();
    const task1 = makeTask({ id: 'task-first', state: 'running', priority: 50 });
    const task2 = makeTask({ id: 'task-second', state: 'running', priority: 30 });

    const actions = decide(
      { kind: 'event', event: attackEvent },
      state,
      world,
      cfg,
      { running: [task1, task2], paused: [] },
    );

    // Only first task in the list should be paused
    const pauseActions = actions.filter(a => a.kind === 'l6.pause') as Array<Extract<Action, { kind: 'l6.pause' }>>;
    assert.equal(pauseActions.length, 1, 'only one task should be paused');
    assert.equal(pauseActions[0].taskId, 'task-first');
  });
});

// ──────────────────────────────────────────────────────────────────
// danger_cleared
// ──────────────────────────────────────────────────────────────────

describe('danger_cleared', () => {
  const clearedEvent = makeEvent('danger_cleared', 'info');

  it('case 1 · no suspended tasks → returns []', () => {
    const state = makeState({
      suspendedByDanger: new Set(), // empty
    });
    const world = makeWorld();

    const actions = decide(
      { kind: 'event', event: clearedEvent },
      state,
      world,
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'no suspended tasks → no actions');
  });

  it('case 2 · has hostile still in range · decide() ignores world · still resumes (tryClearDanger guard is in supervisor.ts runtime)', () => {
    // The world guard (hostile in range check) lives in supervisor.ts tryClearDanger(),
    // NOT in decide(). So decide() always resumes if suspendedByDanger is non-empty.
    const state = makeState({
      suspendedByDanger: new Set(['task-X']),
    });
    const world = makeWorld({
      entities: [
        {
          id: 1,
          name: 'creeper',
          type: 'mob',
          position: { x: 5, y: 64, z: 5 },
          distance: 5, // within HOSTILE_CLEAR_RANGE=16
          category: 'hostile',
        },
      ],
    });

    const actions = decide(
      { kind: 'event', event: clearedEvent },
      state,
      world,
      cfg,
      { running: [], paused: [makeTask({ id: 'task-X', state: 'paused' })] },
    );

    // decide() does not look at world entities for danger_cleared; it trusts the event
    assert.ok(hasKind(actions, 'l6.resume'), 'should resume even if world has hostile (guard is in runtime)');
  });

  it('case 3 · normal clear · resumes all suspended tasks with correct actions', () => {
    const state = makeState({
      suspendedByDanger: new Set(['task-1', 'task-2']),
    });
    const world = makeWorld();

    const actions = decide(
      { kind: 'event', event: clearedEvent },
      state,
      world,
      cfg,
      {
        running: [],
        paused: [
          makeTask({ id: 'task-1', state: 'paused' }),
          makeTask({ id: 'task-2', state: 'paused' }),
        ],
      },
    );

    // Should have l6.resume + state.remove_suspended + bus.publish for each, plus one hb.submitSay
    const resumeActions = actions.filter(a => a.kind === 'l6.resume') as Array<Extract<Action, { kind: 'l6.resume' }>>;
    assert.equal(resumeActions.length, 2, 'should resume all suspended tasks');

    const resumedIds = resumeActions.map(a => a.taskId).sort();
    assert.deepEqual(resumedIds, ['task-1', 'task-2']);

    const removeActions = actions.filter(a => a.kind === 'state.remove_suspended');
    assert.equal(removeActions.length, 2, 'should remove all from suspended set');

    // Each resumed task gets its own bus.publish(supervisor.task_resumed)
    const publishedResumed = getBusPublish(actions, 'supervisor.task_resumed');
    assert.equal(publishedResumed.length, 2, 'should publish supervisor.task_resumed for each task');

    // One narration say
    const sayActions = actions.filter(a => a.kind === 'hb.submitSay');
    assert.equal(sayActions.length, 1, 'exactly one narration say');
  });

  it('case 4 · single suspended task · produces 4 actions (resume + remove + publish + say)', () => {
    const state = makeState({
      suspendedByDanger: new Set(['task-solo']),
    });
    const world = makeWorld();

    const actions = decide(
      { kind: 'event', event: clearedEvent },
      state,
      world,
      cfg,
      { running: [], paused: [makeTask({ id: 'task-solo', state: 'paused' })] },
    );

    assert.equal(actions.length, 4, `expected 4 actions for single task, got ${actions.length}`);
    assert.ok(hasKind(actions, 'l6.resume'));
    assert.ok(hasKind(actions, 'state.remove_suspended'));
    assert.ok(hasKind(actions, 'bus.publish'));
    assert.ok(hasKind(actions, 'hb.submitSay'));
  });
});

// ──────────────────────────────────────────────────────────────────
// tool_broken (and other unknown events)
// ──────────────────────────────────────────────────────────────────

describe('tool_broken', () => {
  it('case 1 · no running task · returns []', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_pickaxe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'no running task → []');
  });

  it('case 2 · running task with no hoeName · ask_master path → push_diagnosis + bus.publish(supervisor.ask_master)', () => {
    const state = makeState();
    const world = makeWorld();
    // task has no hoeName in params, so cannot auto-recover → ask_master
    const task = makeTask({ id: 'task-mining', kind: 'mine', state: 'running' });
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'iron_pickaxe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [task], paused: [] },
    );

    assert.ok(hasKind(actions, 'state.push_diagnosis'), 'should push diagnosis');
    const askMaster = getBusPublish(actions, 'supervisor.ask_master');
    assert.equal(askMaster.length, 1, 'should publish supervisor.ask_master when cannot auto-recover');
  });

  it('case 3 · task has hoeName matching tool_broken → l6.inject craft_item + recovery_started', () => {
    const state = makeState();
    const world = makeWorld();
    const task = makeTask({
      id: 'task-farm',
      kind: 'farm',
      state: 'running',
      preconditions: ['has_hoe_with_durability'],
      params: { hoeName: 'wooden_hoe' },
    });
    // tool matches hoeName — hoeName = tool → no skip
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_hoe', taskId: 'task-farm' });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [task], paused: [] },
    );

    assert.ok(hasKind(actions, 'l6.inject'), 'should inject subtask');
    const injectAction = actions.find(a => a.kind === 'l6.inject') as Extract<Action, { kind: 'l6.inject' }>;
    assert.equal(injectAction.parentTaskId, 'task-farm');
    assert.equal(injectAction.suggestion.kind, 'craft_item');

    const recoveryStarted = getBusPublish(actions, 'supervisor.recovery_started');
    assert.equal(recoveryStarted.length, 1, 'should publish supervisor.recovery_started');
  });

  it('case 4 · already ongoing recovery for task · returns []', () => {
    const task = makeTask({ id: 'task-farm', kind: 'farm', state: 'running', params: { hoeName: 'wooden_hoe' } });
    // ongoingRecoveries has this task
    const state = makeState({
      ongoingRecoveries: new Map([['task-farm', 'subtask-42']]),
    });
    const world = makeWorld();
    const event = makeEvent('tool_broken', 'recoverable', { tool: 'wooden_hoe' });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [task], paused: [] },
    );

    assert.deepEqual(actions, [], 'already recovering → skip (idempotent)');
  });
});

// ──────────────────────────────────────────────────────────────────
// task.preflight_failed event
// ──────────────────────────────────────────────────────────────────

describe('task.preflight_failed event', () => {
  it('case 1 · no taskId in payload → returns []', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('task.preflight_failed', 'recoverable', {}); // no taskId

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'missing taskId → []');
  });

  it('case 2 · with taskId → push_diagnosis + l6.fail (precondition_lost category)', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('task.preflight_failed', 'recoverable', {
      taskId: 'task-42',
      missing: ['has_seeds'],
    });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [makeTask({ id: 'task-42', kind: 'farm' })], paused: [] },
    );

    assert.ok(hasKind(actions, 'state.push_diagnosis'), 'should push diagnosis');
    assert.ok(hasKind(actions, 'l6.fail'), 'precondition_lost category should trigger l6.fail');

    const failAction = actions.find(a => a.kind === 'l6.fail') as Extract<Action, { kind: 'l6.fail' }>;
    assert.equal(failAction.taskId, 'task-42');
  });
});

// ──────────────────────────────────────────────────────────────────
// watchdog / stuck
// ──────────────────────────────────────────────────────────────────

describe('watchdog / stuck', () => {
  it('case 1 · tick delta NOT exceeding STUCK_TICK_THRESHOLD → returns []', () => {
    const task = makeTask({ id: 'task-watch', state: 'running' });
    const lastProgressTick = new Map<string, number>([['task-watch', 100]]);
    const state = makeState({ lastProgressTick });
    const currentTick = 100 + cfg.STUCK_TICK_THRESHOLD; // exactly at threshold, NOT exceeding

    const actions = decide(
      { kind: 'watchdog', tick: currentTick },
      state,
      makeWorld(),
      cfg,
      { running: [task], paused: [] },
    );

    assert.deepEqual(actions, [], `tick delta = ${cfg.STUCK_TICK_THRESHOLD} (not > threshold) → []`);
  });

  it('case 2 · tick delta exceeding STUCK_TICK_THRESHOLD → bus.publish(supervisor.stuck_detected)', () => {
    const task = makeTask({ id: 'task-stuck', state: 'running' });
    const lastProgressTick = new Map<string, number>([['task-stuck', 100]]);
    const state = makeState({ lastProgressTick });
    const currentTick = 100 + cfg.STUCK_TICK_THRESHOLD + 1; // strictly exceeds

    const actions = decide(
      { kind: 'watchdog', tick: currentTick },
      state,
      makeWorld(),
      cfg,
      { running: [task], paused: [] },
    );

    assert.ok(actions.length > 0, 'should produce actions when stuck');
    const stuckPublish = getBusPublish(actions, 'supervisor.stuck_detected');
    assert.equal(stuckPublish.length, 1, 'should publish supervisor.stuck_detected');

    const pub = stuckPublish[0] as Extract<Action, { kind: 'bus.publish' }>;
    const payload = pub.payload as Record<string, unknown>;
    assert.equal(payload['taskId'], 'task-stuck');
    assert.equal(payload['sinceTick'], 100);
    assert.equal(payload['nowTick'], currentTick);
  });

  it('case 3 · no lastProgressTick for task → no stuck detected (first seen tasks are not stuck)', () => {
    const task = makeTask({ id: 'task-new', state: 'running' });
    // lastProgressTick has NO entry for task-new
    const state = makeState({ lastProgressTick: new Map() });

    const actions = decide(
      { kind: 'watchdog', tick: 9999 },
      state,
      makeWorld(),
      cfg,
      { running: [task], paused: [] },
    );

    assert.deepEqual(actions, [], 'task with no lastProgressTick entry → not flagged as stuck');
  });

  it('case 4 · multiple running tasks · only stuck one produces bus.publish', () => {
    const stuckTask = makeTask({ id: 'task-stuck-2', state: 'running' });
    const okTask = makeTask({ id: 'task-ok', state: 'running' });
    const currentTick = 500;
    // stuckTask last progressed at tick 100 (delta = 400 > STUCK_TICK_THRESHOLD=300)
    // okTask last progressed at tick 490 (delta = 10, not stuck)
    const lastProgressTick = new Map<string, number>([
      ['task-stuck-2', 100],
      ['task-ok', 490],
    ]);
    const state = makeState({ lastProgressTick });

    const actions = decide(
      { kind: 'watchdog', tick: currentTick },
      state,
      makeWorld(),
      cfg,
      { running: [stuckTask, okTask], paused: [] },
    );

    const stuckPublishes = getBusPublish(actions, 'supervisor.stuck_detected');
    assert.equal(stuckPublishes.length, 1, 'only one task should be flagged as stuck');

    const pub = stuckPublishes[0] as Extract<Action, { kind: 'bus.publish' }>;
    const payload = pub.payload as Record<string, unknown>;
    assert.equal(payload['taskId'], 'task-stuck-2');
  });

  it('case 5 · no running tasks in watchdog → returns []', () => {
    const state = makeState({
      lastProgressTick: new Map([['task-gone', 0]]),
    });

    const actions = decide(
      { kind: 'watchdog', tick: 9999 },
      state,
      makeWorld(),
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'no running tasks → watchdog yields []');
  });

  it('BUG-CROSS-78 · projection tasks never enter stuck supervision', () => {
    const scheduled = makeTask({ id: 'task-scheduled', executionMode: 'scheduled' });
    const projection = makeTask({ id: 'mirror-projection', executionMode: 'projection' });
    const state = makeState({
      lastProgressTick: new Map([
        [scheduled.id, 100],
        [projection.id, 100],
      ]),
    });
    const actions = decide(
      { kind: 'watchdog', tick: 100 + cfg.STUCK_TICK_THRESHOLD + 1 },
      state,
      makeWorld(),
      cfg,
      { running: [scheduled, projection], paused: [] },
    );
    const stuck = getBusPublish(actions, 'supervisor.stuck_detected')
      .map(action => (action as Extract<Action, { kind: 'bus.publish' }>).payload as { taskId: string });
    assert.deepEqual(stuck.map(value => value.taskId), [scheduled.id]);
  });
});

// ──────────────────────────────────────────────────────────────────
// supervisor.stuck_detected event (re-entering via event bus)
// ──────────────────────────────────────────────────────────────────

describe('supervisor.stuck_detected event', () => {
  it('case 1 · no taskId in payload → returns []', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('supervisor.stuck_detected', 'recoverable', {}); // no taskId

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [], paused: [] },
    );

    assert.deepEqual(actions, [], 'no taskId → []');
  });

  it('case 2 · with taskId (persistent task) → push_diagnosis + l6.inject (planRecovery)', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('supervisor.stuck_detected', 'recoverable', {
      taskId: 'task-99',
      sinceTick: 50,
      nowTick: 101,
    });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [makeTask({ id: 'task-99' })], paused: [] },
    );

    assert.ok(hasKind(actions, 'state.push_diagnosis'), 'should push diagnosis for stuck');
    // persistent tasks (follow_owner) go through planRecovery → subtask (reset_pathfinder)
    assert.ok(hasKind(actions, 'l6.inject'), 'stuck persistent task should trigger l6.inject (planRecovery)');
  });

  it('case 2b · with taskId (non-persistent task) → push_diagnosis + l6.fail', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('supervisor.stuck_detected', 'recoverable', {
      taskId: 'task-99',
      sinceTick: 50,
      nowTick: 101,
    });

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [makeTask({ id: 'task-99', kind: 'farm' })], paused: [] },
    );

    assert.ok(hasKind(actions, 'state.push_diagnosis'), 'should push diagnosis for stuck');
    assert.ok(hasKind(actions, 'l6.fail'), 'stuck non-persistent task should trigger l6.fail');

    const failAction = actions.find(a => a.kind === 'l6.fail') as Extract<Action, { kind: 'l6.fail' }>;
    assert.equal(failAction.taskId, 'task-99');
  });
});

// ──────────────────────────────────────────────────────────────────
// Unknown / default events
// ──────────────────────────────────────────────────────────────────

describe('default / unknown events', () => {
  it('case 1 · completely unknown event type → returns []', () => {
    const state = makeState();
    const world = makeWorld();
    const event = makeEvent('inventory_full', 'suggestion');

    const actions = decide(
      { kind: 'event', event },
      state,
      world,
      cfg,
      { running: [makeTask()], paused: [] },
    );

    assert.deepEqual(actions, [], 'unknown event type → []');
  });

  it('case 2 · world is null (no perception data) · under_attack still acts on tasks', () => {
    const state = makeState();
    const task = makeTask({ id: 'task-null-world', state: 'running' });
    const attackEvent = makeEvent('under_attack', 'critical');

    // world=null is allowed per decide() signature
    const actions = decide(
      { kind: 'event', event: attackEvent },
      state,
      null,
      cfg,
      { running: [task], paused: [] },
    );

    assert.ok(hasKind(actions, 'l6.pause'), 'null world should not prevent under_attack from pausing');
    assert.ok(hasKind(actions, 'state.add_suspended'));
  });
});

describe('FEAT-CROSS-06 · goal_exec 恢复决策单一真相源', () => {
  it('under_attack 时 Supervisor 不产生第二套暂停/逃跑决策', () => {
    const actions = decide(
      { kind: 'event', event: makeEvent('under_attack', 'critical') },
      makeState(),
      makeWorld(),
      cfg,
      { running: [makeTask({ id: 'goal-1', kind: 'goal_exec' })], paused: [] },
    );

    assert.deepEqual(actions, []);
  });

  it('tool_broken 时只记诊断，不走 RecoveryPlanner', () => {
    const actions = decide(
      { kind: 'event', event: makeEvent('tool_broken', 'recoverable', { tool: 'iron_pickaxe' }) },
      makeState(),
      makeWorld(),
      cfg,
      { running: [makeTask({ id: 'goal-2', kind: 'goal_exec' })], paused: [] },
    );

    assert.deepEqual(kinds(actions), ['state.push_diagnosis']);
  });

  it('preflight_failed 时只记诊断，不 fail/inject/ask', () => {
    const actions = decide(
      { kind: 'event', event: makeEvent('task.preflight_failed', 'recoverable', { taskId: 'goal-3', missing: ['ore'] }) },
      makeState(),
      makeWorld(),
      cfg,
      { running: [makeTask({ id: 'goal-3', kind: 'goal_exec' })], paused: [] },
    );

    assert.deepEqual(kinds(actions), ['state.push_diagnosis']);
  });

  it('watchdog 可发 stuck 信号，事件回流后仍只记诊断', () => {
    const goalTask = makeTask({ id: 'goal-4', kind: 'goal_exec' });
    const watchdogActions = decide(
      { kind: 'watchdog', tick: cfg.STUCK_TICK_THRESHOLD + 2 },
      makeState({ lastProgressTick: new Map([['goal-4', 1]]) }),
      makeWorld(),
      cfg,
      { running: [goalTask], paused: [] },
    );
    assert.equal(getBusPublish(watchdogActions, 'supervisor.stuck_detected').length, 1);

    const eventActions = decide(
      { kind: 'event', event: makeEvent('supervisor.stuck_detected', 'recoverable', { taskId: 'goal-4' }) },
      makeState(),
      makeWorld(),
      cfg,
      { running: [goalTask], paused: [] },
    );
    assert.deepEqual(kinds(eventActions), ['state.push_diagnosis']);
  });
});
