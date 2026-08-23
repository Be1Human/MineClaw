import type { EventBusV2 } from '../../infra/eventBus.js';
import type { BusEvent, WorldStateView } from '../../types.js';
import type { EnvironmentSnapshot, EpisodeParticipant } from '../contracts.js';
import { EpisodeAssembler } from './episodeAssembler.js';
import type { EpisodeApplyResult } from './contracts.js';

export interface RuntimeEpisodeCaptureConfig {
  profileId: string;
  ownerName: string;
  botName: string;
  bus: EventBusV2;
  assembler: EpisodeAssembler;
  world: () => WorldStateView | null;
  onApplied?: (result: EpisodeApplyResult) => void;
}

/** Converts durable runtime signals into deterministic episode observations. */
export class RuntimeEpisodeCapture {
  private readonly unsubs: Array<() => void> = [];
  private activeCombatCorrelation: string | null = null;

  constructor(private readonly config: RuntimeEpisodeCaptureConfig) {
    this.unsubs.push(
      config.bus.on('task.started', event => this.onTask(event, 'started')),
      config.bus.on('task.completed', event => this.onTask(event, 'completed')),
      config.bus.on('task.failed', event => this.onTask(event, 'failed')),
      config.bus.on('task.cancelled', event => this.onTask(event, 'cancelled')),
      config.bus.on('under_attack', event => this.onAttack(event)),
      config.bus.on('atomic.attack', event => this.onCombatEvent(event)),
      config.bus.on('danger_cleared', event => this.finishCombat(event, 'survived')),
      config.bus.on('bot.death', event => this.finishCombat(event, 'died')),
    );
  }

  stop(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
  }

  private onTask(event: BusEvent, outcome: 'started' | 'completed' | 'failed' | 'cancelled'): void {
    const payload = object(event.payload);
    const taskId = string(payload.taskId);
    if (!taskId) return;
    const taskKind = string(payload.kind) || 'unknown';
    const terminal = outcome !== 'started';
    const world = this.config.world();
    this.accept({
      observationId: `runtime:${event.id}`,
      profileId: this.config.profileId,
      phase: terminal ? 'terminal' : 'started',
      kind: 'task',
      timestamp: event.timestamp,
      correlationId: `task:${taskId}`,
      taskId,
      locationRef: locationRef(world),
      snapshot: environmentSnapshot(event, world, taskId),
      participants: participants(world, this.config.ownerName, this.config.botName),
      eventSummary: terminal ? `任务 ${taskKind} ${outcome}` : `开始任务 ${taskKind}`,
      ...(terminal ? { outcome } : {}),
      sourceRefs: [{ store: 'event-bus', id: event.id }],
      keyFrame: true,
    });
  }

  private onAttack(event: BusEvent): void {
    const world = this.config.world();
    const taskId = world?.taskContext?.currentTaskId ?? undefined;
    if (!this.activeCombatCorrelation) {
      this.activeCombatCorrelation = `combat:${taskId ?? locationRef(world) ?? event.id}`;
    }
    const payload = object(event.payload);
    this.accept({
      observationId: `runtime:${event.id}`,
      profileId: this.config.profileId,
      phase: 'event',
      kind: 'combat',
      timestamp: event.timestamp,
      correlationId: this.activeCombatCorrelation,
      ...(taskId ? { taskId } : {}),
      locationRef: locationRef(world),
      snapshot: environmentSnapshot(event, world, taskId),
      participants: participants(world, this.config.ownerName, this.config.botName),
      eventSummary: `受到攻击，损失 ${number(payload.damage)} 点生命`,
      emotionTags: event.level === 'critical' ? ['危险'] : ['紧张'],
      sourceRefs: [{ store: 'event-bus', id: event.id }],
      keyFrame: true,
    });
  }

  private onCombatEvent(event: BusEvent): void {
    if (!this.activeCombatCorrelation) return;
    const world = this.config.world();
    const payload = object(event.payload);
    this.accept({
      observationId: `runtime:${event.id}`,
      profileId: this.config.profileId,
      phase: 'event',
      kind: 'combat',
      timestamp: event.timestamp,
      correlationId: this.activeCombatCorrelation,
      taskId: world?.taskContext?.currentTaskId ?? undefined,
      locationRef: locationRef(world),
      snapshot: environmentSnapshot(event, world, world?.taskContext?.currentTaskId ?? undefined),
      participants: participants(world, this.config.ownerName, this.config.botName),
      eventSummary: `反击 ${string(payload.target) || string(payload.entityId) || '敌对生物'}`,
      sourceRefs: [{ store: 'event-bus', id: event.id }],
    });
  }

  private finishCombat(event: BusEvent, outcome: 'survived' | 'died'): void {
    if (!this.activeCombatCorrelation) return;
    const world = this.config.world();
    this.accept({
      observationId: `runtime:${event.id}`,
      profileId: this.config.profileId,
      phase: 'terminal',
      kind: 'combat',
      timestamp: event.timestamp,
      correlationId: this.activeCombatCorrelation,
      taskId: world?.taskContext?.currentTaskId ?? undefined,
      locationRef: locationRef(world),
      snapshot: environmentSnapshot(event, world, world?.taskContext?.currentTaskId ?? undefined),
      participants: participants(world, this.config.ownerName, this.config.botName),
      eventSummary: outcome === 'died' ? '战斗以死亡结束' : '威胁解除并脱险',
      outcome,
      emotionTags: outcome === 'died' ? ['挫败'] : ['惊险'],
      sourceRefs: [{ store: 'event-bus', id: event.id }],
      keyFrame: true,
    });
    this.activeCombatCorrelation = null;
  }

  private accept(observation: Parameters<EpisodeAssembler['accept']>[0]): void {
    const result = this.config.assembler.accept(observation);
    this.config.onApplied?.(result);
  }
}

function environmentSnapshot(event: BusEvent, world: WorldStateView | null, taskId?: string): EnvironmentSnapshot {
  return {
    timestamp: event.timestamp,
    ...(world ? {
      dimension: world.environment.dimension,
      position: { ...world.self.position },
      nearbyHostiles: world.entities.filter(item => item.category === 'hostile').slice(0, 12).map(entityRef),
      ownerDistance: Number.isFinite(world.owner?.distance) ? world.owner!.distance : undefined,
      hazards: [],
      health: world.self.health,
      food: world.self.food,
      ...(taskId ? { taskId } : {}),
      ...(world.taskContext?.currentTaskKind ? { goal: world.taskContext.currentTaskKind } : {}),
    } : { nearbyHostiles: [], hazards: [], ...(taskId ? { taskId } : {}) }),
    sourceEventIds: [event.id],
  };
}

function participants(world: WorldStateView | null, ownerName: string, botName: string): EpisodeParticipant[] {
  const values: EpisodeParticipant[] = [
    { id: ownerName, kind: 'owner' },
    { id: botName, kind: 'agent' },
  ];
  for (const entity of world?.entities.filter(item => item.category === 'hostile').slice(0, 12) ?? []) {
    values.push({ id: entityRef(entity), kind: 'mob', role: 'hostile' });
  }
  return values;
}

function entityRef(entity: { id: number; name: string }): string {
  return `${entity.name}:${entity.id}`;
}

function locationRef(world: WorldStateView | null): string | undefined {
  if (!world) return undefined;
  const x = Math.floor(world.self.position.x / 32);
  const z = Math.floor(world.self.position.z / 32);
  return `${world.environment.dimension}:grid:${x}:${z}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
