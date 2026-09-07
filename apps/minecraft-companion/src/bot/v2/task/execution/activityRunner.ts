import { randomUUID } from 'node:crypto';
import type { EventBusV2 } from '../../infra/eventBus.js';
import type { WorldStateView } from '../../types.js';
import { createScopedHostContext } from '../../plugin-sdk/contracts/scopedContext.js';
import type { PluginActivityInstance, PluginActivityWorld } from '../../plugin-sdk/contracts/execution.js';
import type { ContributionRef, PluginGoalLease, RegistrySnapshotRef } from '../../plugin-sdk/identity.js';
import type { TaskRuntime } from '../taskRuntime.js';
import type { BodyActionService } from './bodyActionService.js';
import type { GenerationActivityResolverPort } from './generationResolversPorts.js';

/** Player inventory has 36 storage slots; this is a fixed protocol bound, not a behavior setting. */
const ACTIVITY_INVENTORY_ITEM_LIMIT = 36;

export interface ActivityStartRequest {
  readonly snapshot: RegistrySnapshotRef;
  readonly contribution: ContributionRef;
  readonly params: Readonly<Record<string, unknown>>;
  readonly label: string;
  readonly priority: number;
}

export interface ActivityRuntimeSnapshot {
  readonly taskId: string;
  readonly state: 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled';
  readonly contribution: ContributionRef;
  readonly snapshot: RegistrySnapshotRef;
  readonly error?: string;
}

interface RunningActivity {
  readonly taskId: string;
  readonly controller: AbortController;
  readonly instance: PluginActivityInstance;
  readonly request: ActivityStartRequest;
  /** Copied at start from the fixed-generation factory; never read from the live registry. */
  readonly hazardCategories: readonly string[];
  state: ActivityRuntimeSnapshot['state'];
  error?: string;
  run: Promise<void>;
  stopping: Promise<void> | null;
  sequence: number;
}

/** Owns persistent plugin instances; every physical step still goes through BodyActionService. */
export class ActivityRunner {
  private readonly entries = new Map<string, RunningActivity>();

  constructor(private readonly deps: {
    readonly tasks: TaskRuntime;
    readonly body: BodyActionService;
    readonly bus: EventBusV2;
    readonly activities: GenerationActivityResolverPort;
    readonly hostApiVersion: string;
    readonly getWorld: () => WorldStateView;
    /** Host-owned hot settings; each activity read receives an immutable clone. */
    readonly getHostConfig: () => Readonly<Record<string, unknown>>;
  }) {}

  prepare(input: Omit<ActivityStartRequest, 'params' | 'label' | 'priority'> & {
    readonly requestText: string;
  }): Readonly<Record<string, unknown>> {
    const resolved = this.deps.activities.resolve(input.snapshot, input.contribution);
    if (resolved.status === 'in_doubt') throw new Error(`activity_unavailable:${resolved.reason}`);
    return resolved.value.factory.prepareStart({
      requestText: input.requestText,
      world: projectWorld(this.deps.getWorld()),
      hostConfig: hostConfigSnapshot(this.deps.getHostConfig),
    });
  }

  start(request: ActivityStartRequest): ActivityRuntimeSnapshot {
    const resolved = this.deps.activities.resolve(request.snapshot, request.contribution);
    if (resolved.status === 'in_doubt') throw new Error(`activity_unavailable:${resolved.reason}`);
    const task = this.deps.tasks.createTask(`plugin_activity:${resolved.value.factory.id}`, {
      contribution: request.contribution,
      snapshot: request.snapshot,
      params: structuredClone(request.params),
    }, { priority: request.priority, label: request.label, feedbackPolicy: 'internal' });
    const started = this.deps.tasks.start(task.id, this.deps.getWorld());
    if (!started.ok) throw new Error(started.reason ?? 'activity_task_start_failed');
    const controller = new AbortController();
    const lease: PluginGoalLease = Object.freeze({
      goalId: task.id,
      sessionId: task.id,
      snapshot: request.snapshot,
      ownerEpoch: 1,
      operationEpoch: 1,
      aborted: false,
    });
    let instance: PluginActivityInstance;
    try {
      instance = resolved.value.factory.create(lease, createScopedHostContext(
        { version: this.deps.hostApiVersion, buildId: request.snapshot.buildId },
        { pluginId: request.contribution.pluginId, pluginVersion: request.contribution.pluginVersion },
      ));
    } catch (error) {
      this.deps.tasks.fail(task.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const entry: RunningActivity = {
      taskId: task.id,
      controller,
      instance,
      request,
      hazardCategories: Object.freeze([...new Set(resolved.value.factory.hazardPolicy?.categories ?? [])]),
      state: 'running',
      run: Promise.resolve(),
      stopping: null,
      sequence: 0,
    };
    this.entries.set(task.id, entry);
    entry.run = this.run(entry, lease);
    this.deps.bus.publish('activity.started', 'info', { taskId: task.id, contribution: request.contribution, snapshot: request.snapshot });
    return this.snapshot(entry);
  }

  owns(taskId: string): boolean { return this.entries.has(taskId); }

  /**
   * Reports whether a currently running activity declared ownership of this
   * hazard category.  The answer is based only on the factory that was
   * resolved into that activity's fixed generation.
   */
  handlesHazard(category: string): boolean {
    return [...this.entries.values()].some(entry => entry.state === 'running' && entry.hazardCategories.includes(category));
  }

  inspect(taskId: string): ActivityRuntimeSnapshot | null {
    const entry = this.entries.get(taskId);
    return entry ? this.snapshot(entry) : null;
  }

  cancel(taskId: string, reason: string): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    entry.state = 'stopping';
    entry.stopping = this.stop(entry, reason);
    return entry.stopping;
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => this.cancel(entry.taskId, 'activity_runner_closed')));
  }

  private async run(entry: RunningActivity, lease: PluginGoalLease): Promise<void> {
    try {
      const result = await entry.instance.run({
        goal: lease,
        signal: entry.controller.signal,
        params: entry.request.params,
        observe: () => projectWorld(this.deps.getWorld()),
        getHostConfig: () => hostConfigSnapshot(this.deps.getHostConfig),
        submitBody: async raw => {
          if (entry.controller.signal.aborted) return { ok: false, error: 'activity_cancelled' };
          const atomicId = raw.atomicId;
          const args = raw.args;
          const timeoutMs = raw.timeoutMs;
          if (!atomicId || !args || typeof args !== 'object' || Array.isArray(args)
            || (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))) return { ok: false, error: 'invalid_activity_body_request' };
          const result = await this.deps.body.executeActivity({
            taskId: entry.taskId,
            operationId: `activity:${entry.taskId}:${++entry.sequence}:${randomUUID()}`,
            snapshot: entry.request.snapshot,
            atomicId,
            args: args as Readonly<Record<string, unknown>>,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            priority: entry.request.priority,
            signal: entry.controller.signal,
          });
          return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
        },
        wait: ms => abortableWait(ms, entry.controller.signal),
        publish: (type, level, payload) => this.deps.bus.publish(type, level === 'info' ? 'info' : 'recoverable', payload),
      });
      if (entry.state !== 'running') return;
      if (result.ok) {
        entry.state = 'completed';
        this.deps.tasks.complete(entry.taskId);
      } else {
        entry.state = result.cancelled ? 'cancelled' : 'failed';
        entry.error = result.error ?? 'activity_failed';
        if (result.cancelled) this.deps.tasks.cancel(entry.taskId, entry.error);
        else this.deps.tasks.fail(entry.taskId, entry.error);
      }
    } catch (error) {
      if (entry.state !== 'running') return;
      entry.state = entry.controller.signal.aborted ? 'cancelled' : 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      if (entry.state === 'cancelled') this.deps.tasks.cancel(entry.taskId, entry.error);
      else this.deps.tasks.fail(entry.taskId, entry.error);
    } finally {
      if (entry.state !== 'stopping') await entry.instance.close();
    }
  }

  private async stop(entry: RunningActivity, reason: string): Promise<void> {
    entry.controller.abort(new Error(reason));
    const stopped = await Promise.allSettled([
      entry.instance.halt(),
      this.deps.body.drainTask(entry.taskId, reason),
    ]);
    await entry.run;
    const closed = await Promise.allSettled([entry.instance.close()]);
    const failures = [...stopped, ...closed].flatMap(value => value.status === 'rejected' ? [value.reason] : []);
    if (failures.length) {
      entry.state = 'failed';
      entry.error = 'activity_stop_unconfirmed';
      this.deps.tasks.fail(entry.taskId, entry.error);
      throw new AggregateError(failures, entry.error);
    }
    entry.state = 'cancelled';
    this.deps.tasks.cancel(entry.taskId, reason);
    this.deps.bus.publish('activity.stopped', 'info', { taskId: entry.taskId, reason, stopConfirmed: true });
  }

  private snapshot(entry: RunningActivity): ActivityRuntimeSnapshot {
    return Object.freeze({
      taskId: entry.taskId,
      state: entry.state,
      contribution: entry.request.contribution,
      snapshot: entry.request.snapshot,
      ...(entry.error ? { error: entry.error } : {}),
    });
  }
}

function projectWorld(world: WorldStateView): PluginActivityWorld {
  const projectItem = (item: WorldStateView['inventory']['items'][number]) => Object.freeze({
    name: item.name,
    count: item.count,
    slot: item.slot,
    ...(item.durability === undefined ? {} : { durability: item.durability }),
    ...(item.maxDurability === undefined ? {} : { maxDurability: item.maxDurability }),
  });
  const projectArmor = (item: { name: string; count: number; slot: number } | null | undefined) => item
    ? Object.freeze({ name: item.name, count: item.count, slot: item.slot })
    : null;
  return Object.freeze({
    tick: world.tick,
    observedAt: world.timestamp,
    self: Object.freeze({
      position: Object.freeze({ ...world.self.position }),
      health: world.self.health,
      maxHealth: world.self.maxHealth,
      food: world.self.food,
    }),
    owner: world.owner ? Object.freeze({
      username: world.owner.username,
      position: world.owner.position ? Object.freeze({ ...world.owner.position }) : null,
      distance: world.owner.distance,
      entityId: world.owner.entityId,
      isVisible: world.owner.isVisible,
    }) : null,
    inventory: Object.freeze({
      items: Object.freeze(world.inventory.items.slice(0, ACTIVITY_INVENTORY_ITEM_LIMIT).map(projectItem)),
      held: world.inventory.held ? projectItem(world.inventory.held) : null,
      armor: Object.freeze({
        head: projectArmor(world.inventory.armor?.head),
        torso: projectArmor(world.inventory.armor?.torso),
        legs: projectArmor(world.inventory.armor?.legs),
        feet: projectArmor(world.inventory.armor?.feet),
      }),
      freeSlots: world.inventory.freeSlots,
    }),
    entities: Object.freeze(world.entities.map(entity => Object.freeze({
      id: entity.id,
      name: entity.name,
      category: entity.category,
      distance: entity.distance,
      position: Object.freeze({ ...entity.position }),
      ...(entity.droppedItem ? { droppedItem: Object.freeze({ ...entity.droppedItem }) } : {}),
    }))),
  });
}

function hostConfigSnapshot(read: () => Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const source = read();
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('activity_host_config_invalid');
  return deepFreeze(structuredClone(source));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('activity_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    timer.unref?.();
    signal.addEventListener('abort', cancelled, { once: true });
    function done(): void { signal.removeEventListener('abort', cancelled); resolve(); }
    function cancelled(): void { clearTimeout(timer); reject(signal.reason ?? new Error('activity_cancelled')); }
  });
}
