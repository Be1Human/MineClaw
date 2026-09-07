import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Heartbeat, type HeartbeatConfig, type HeartbeatDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/heartbeat.js';
import { OwnerThreatHeartbeatCadencePolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/heartbeatCadence.js';
import type { ActionRequest, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { IStrategy, StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';

const cfg: HeartbeatConfig = { cadence: { nextDelayMs: () => 200 }, blockingExecute: true };

function world(hostiles = false): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: hostiles ? [{ id: 8, name: 'zombie', type: 'mob', position: { x: 3, y: 64, z: 0 }, distance: 3, category: 'hostile' }] : [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: 'request-1',
    source: 'test',
    type: 'attack',
    priority: 90,
    interrupt_level: 'hard',
    resource: ['movement'],
    target: { entityId: 8 },
    preconditions: [],
    timeout_ms: 500,
    ...overrides,
  };
}

function strategy(
  id: string,
  tick: (ctx: StrategyContext) => ActionRequest[],
  extras: Partial<IStrategy> = {},
): IStrategy {
  return {
    id,
    kind: 'rule',
    isActive: () => true,
    tick,
    inspect: () => ({ kind: 'rule', view: {} }),
    ...extras,
  };
}

class FakeClock {
  private readonly pending: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];

  setTimeout(callback: () => void, delayMs: number): object {
    const timer = { callback, delayMs, cleared: false };
    this.pending.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }

  runNext(): number {
    const next = this.pending.shift();
    assert.ok(next, 'expected a scheduled heartbeat');
    if (!next.cleared) next.callback();
    return next.delayMs;
  }

  count(): number {
    return this.pending.filter(timer => !timer.cleared).length;
  }
}

function makeDeps(input: {
  activeTaskId?: string | null;
  hostiles?: boolean;
  hazardManaged?: boolean;
  automaticDefenseEnabled?: () => boolean;
  fallback?: IStrategy[];
  taskStrategies?: IStrategy[];
  embodied?: boolean;
} = {}) {
  const events: Array<{ type: string; payload: unknown }> = [];
  const executed: ActionRequest[] = [];
  const calls: string[] = [];
  const liveTask = input.activeTaskId === null ? null : {
    id: input.activeTaskId ?? 'task-live',
    kind: 'follow_owner',
    params: {},
    state: 'running',
    progress: {},
  };
  const body = {
    busy: () => false,
    currentRequest: () => null,
    cancelAll: () => { calls.push('body.cancelAll'); },
    executeTask: async (action: ActionRequest) => {
      executed.push(action);
      return { ok: true, request: action, durationMs: 0 };
    },
  };
  const deps: HeartbeatDeps = {
    bus: {
      drain: () => { calls.push('drain'); return []; },
      publish: (type: string, _level: string, payload: unknown) => { events.push({ type, payload }); },
      on: () => () => {},
    } as never,
    memory: { commitTick: () => 0, setRuntime: () => {} } as never,
    perception: { perceive: () => { calls.push('perceive'); return world(input.hostiles); } } as never,
    tasks: {
      active: () => liveTask,
      sched: () => { calls.push('sched'); },
      isRunning: (id: string) => id === liveTask?.id,
      list: () => [],
      complete: () => {},
    } as never,
    supervisor: { watchdog: () => { calls.push('watchdog'); } } as never,
    taskStrategies: input.taskStrategies ?? [],
    hazardFallbackStrategies: input.fallback ?? [],
    isHazardManaged: () => input.hazardManaged ?? false,
    isAutomaticDefenseEnabled: input.automaticDefenseEnabled ?? (() => true),
    body: body as never,
    isEmbodied: () => input.embodied ?? true,
  };
  return { deps, body, events, executed, calls };
}

async function tick(heartbeat: Heartbeat): Promise<void> {
  await (heartbeat as unknown as { runTick(): Promise<void> }).runTick();
}

describe('Heartbeat hazard route and unified task execution', () => {
  it('backs generic fallback actions with the currently running task and calls executeTask', async () => {
    const fallback = strategy('generic-survival', () => [request()]);
    const harness = makeDeps({ hostiles: true, fallback: [fallback] });
    const heartbeat = new Heartbeat(cfg, harness.deps);

    await tick(heartbeat);

    assert.equal(harness.executed.length, 1);
    assert.equal(harness.executed[0]?.taskId, 'task-live');
    assert.equal(harness.executed[0]?.source, 'test');
  });

  it('a declared running Activity suppresses generic fallback for the entire recovery lifecycle', async () => {
    let fallbackTicks = 0;
    const fallback = strategy('generic-survival', () => {
      fallbackTicks += 1;
      return [request()];
    });
    const harness = makeDeps({ hazardManaged: true, fallback: [fallback] });
    const heartbeat = new Heartbeat(cfg, harness.deps);

    await tick(heartbeat);

    assert.equal(fallbackTicks, 0);
    assert.deepEqual(harness.executed, []);
  });

  it('without a declaration, hostile evidence permits generic fallback', async () => {
    let fallbackTicks = 0;
    const fallback = strategy('generic-survival', () => {
      fallbackTicks += 1;
      return [];
    });
    const harness = makeDeps({ hostiles: true, fallback: [fallback] });

    await tick(new Heartbeat(cfg, harness.deps));

    assert.equal(fallbackTicks, 1);
  });

  it('never invents a safety owner: an unbacked fallback action is rejected', async () => {
    const fallback = strategy('generic-survival', () => [request()]);
    const harness = makeDeps({ hostiles: true, activeTaskId: null, fallback: [fallback] });
    const heartbeat = new Heartbeat(cfg, harness.deps);

    await tick(heartbeat);

    assert.deepEqual(harness.executed, []);
    assert.equal(harness.events.some(event => event.type === 'arbiter.orphan_request'), true);
  });

  it('automatic-defense switch resets fallback state without a separate body execution path', async () => {
    const calls: string[] = [];
    const fallback = strategy('generic-survival', () => [request()], { suspend: () => calls.push('fallback.suspend') });
    const harness = makeDeps({ hostiles: true, fallback: [fallback], automaticDefenseEnabled: () => false });

    await tick(new Heartbeat(cfg, harness.deps));

    assert.deepEqual(calls, ['fallback.suspend']);
    assert.equal(harness.executed.length, 0);
    assert.equal(harness.calls.includes('body.cancelAll'), true);
  });

  it('keeps normal task strategies on the same execution path', async () => {
    const normal = strategy('normal-task', () => [request({ id: 'normal-request', source: 'normal' })]);
    const harness = makeDeps({ taskStrategies: [normal] });

    await tick(new Heartbeat(cfg, harness.deps));

    assert.equal(harness.executed.length, 1);
    assert.equal(harness.executed[0]?.taskId, 'task-live');
  });

  it('companion mode never runs body-capable fallback strategies', async () => {
    let fallbackTicks = 0;
    const fallback = strategy('generic-survival', () => { fallbackTicks += 1; return [request()]; });
    const harness = makeDeps({ hostiles: true, fallback: [fallback], embodied: false });

    await tick(new Heartbeat(cfg, harness.deps));

    assert.equal(fallbackTicks, 0);
    assert.deepEqual(harness.executed, []);
  });
});

describe('Heartbeat cadence', () => {
  const policy = new OwnerThreatHeartbeatCadencePolicy(() => ({
    idleIntervalMs: 250,
    ownerVisibleIntervalMs: 100,
    ownerThreatIntervalMs: 50,
    ownerThreatRadius: 12,
  }));

  it('uses the urgent cadence only for a hostile near a visible owner', () => {
    const state = world(true);
    state.owner = { username: 'owner', entityId: 1, isVisible: true, distance: 3, position: { x: 0, y: 64, z: 0 } };
    assert.equal(policy.nextDelayMs({ embodied: true, world: state }), 50);
  });

  it('uses the aware and idle cadences without permanent high-frequency polling', () => {
    const visible = world();
    visible.owner = { username: 'owner', entityId: 1, isVisible: true, distance: 3, position: { x: 0, y: 64, z: 0 } };
    assert.equal(policy.nextDelayMs({ embodied: true, world: visible }), 100);
    assert.equal(policy.nextDelayMs({ embodied: true, world: { ...visible, owner: null } }), 250);
    assert.equal(policy.nextDelayMs({ embodied: false, world: visible }), 250);
  });

  it('never schedules a second heartbeat while the current execution is still running', async () => {
    const clock = new FakeClock();
    let releaseExecution: (() => void) | undefined;
    const execution = new Promise<void>(resolve => { releaseExecution = resolve; });
    const action = strategy('slow-action', () => [request()]);
    const harness = makeDeps({ taskStrategies: [action] });
    harness.body.executeTask = async (next: ActionRequest) => {
      harness.executed.push(next);
      await execution;
      return { ok: true, request: next, durationMs: 0 };
    };
    const heartbeat = new Heartbeat({
      blockingExecute: true,
      cadence: { nextDelayMs: () => 50 },
      clock,
    }, harness.deps);

    heartbeat.start();
    assert.equal(clock.runNext(), 0);
    await Promise.resolve();
    assert.equal(harness.executed.length, 1);
    assert.equal(clock.count(), 0);

    releaseExecution?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(clock.count(), 1);
    assert.ok(clock.runNext() >= 0);
    heartbeat.stop();
  });

  it('falls back to a safe positive delay when a custom cadence is invalid', async () => {
    const clock = new FakeClock();
    const heartbeat = new Heartbeat({
      blockingExecute: true,
      cadence: { nextDelayMs: () => Number.NaN },
      clock,
    }, makeDeps().deps);

    heartbeat.start();
    assert.equal(clock.runNext(), 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(clock.runNext() > 0);
    heartbeat.stop();
  });
});
