import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SUPERVISOR_CONFIG,
  decide,
  type Action,
  type SupervisorState,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorDecide.js';
import type { BusEvent, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-live',
    kind: 'follow_owner',
    params: {},
    priority: 30,
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
    lastActiveTick: 1,
    preconditions: [],
    ...overrides,
  } as Task;
}

function state(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    ongoingRecoveries: new Map(),
    recentDiagnoses: [],
    lastProgressTick: new Map(),
    recoveryAttempts: new Map(),
    narrationCooldowns: new Map(),
    ...overrides,
  };
}

function event(type: string, level: BusEvent['level'], payload: unknown = {}): BusEvent {
  return { id: `event:${type}`, type, level, payload, timestamp: 1 };
}

function kinds(actions: readonly Action[]): string[] {
  return actions.map(action => action.kind);
}

describe('RuntimeSupervisor hazard boundary', () => {
  it('under_attack never pauses or otherwise mutates a running task', () => {
    const actions = decide(
      { kind: 'event', event: event('under_attack', 'critical') },
      state(),
      world(),
      DEFAULT_SUPERVISOR_CONFIG,
      { running: [task()], paused: [] },
    );

    assert.deepEqual(actions, []);
  });

  it('danger_cleared cannot claim a task transition', () => {
    const actions = decide(
      { kind: 'event', event: event('danger_cleared', 'info') },
      state(),
      world(),
      DEFAULT_SUPERVISOR_CONFIG,
      { running: [], paused: [task({ id: 'legacy-paused-task', state: 'paused' })] },
    );

    assert.deepEqual(actions, []);
  });

  it('watchdog still reports a genuinely stuck non-projection task', () => {
    const live = task({ id: 'stuck-task', lastActiveTick: 1 });
    const actions = decide(
      { kind: 'watchdog', tick: DEFAULT_SUPERVISOR_CONFIG.STUCK_TICK_THRESHOLD + 2 },
      state({ lastProgressTick: new Map([[live.id, 1]]) }),
      world(),
      DEFAULT_SUPERVISOR_CONFIG,
      { running: [live], paused: [] },
    );

    assert.deepEqual(kinds(actions), ['bus.publish']);
    assert.equal((actions[0] as Extract<Action, { kind: 'bus.publish' }>).eventType, 'supervisor.stuck_detected');
  });

  it('tool_broken retains the non-hazard recovery path', () => {
    const live = task({ kind: 'farm', params: { hoeName: 'wooden_hoe' } });
    const actions = decide(
      { kind: 'event', event: event('tool_broken', 'recoverable', { tool: 'wooden_hoe' }) },
      state(),
      world(),
      DEFAULT_SUPERVISOR_CONFIG,
      { running: [live], paused: [] },
    );

    assert.ok(kinds(actions).includes('state.push_diagnosis'));
    assert.ok(kinds(actions).includes('l6.inject'));
  });
});
