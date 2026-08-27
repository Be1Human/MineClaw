import type { VisualWorldDelta } from '../bot/adapter/VisualWorldSource.js';

export interface VisualWorldDeltaBatch {
  protocol: 'mineclaw.visual-world-delta/v1';
  sessionId: string;
  generation: number;
  fromSequence: number;
  toSequence: number;
  deltas: VisualWorldDelta[];
  createdAt: number;
}

export class VisualWorldDeltaBatcher {
  private readonly queues = new Map<string, {
    deltas: Map<string, VisualWorldDelta>;
    sessionId: string;
    generation: number;
    fromSequence: number;
    toSequence: number;
  }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly limits: () => { deltaBatchMs: number; maxDeltaBatchEntries: number },
    private readonly send: (botId: string, batch: VisualWorldDeltaBatch) => void,
  ) {}

  enqueue(botId: string, delta: VisualWorldDelta): void {
    let queue = this.queues.get(botId);
    if (!queue || queue.sessionId !== delta.sessionId) {
      queue = {
        deltas: new Map(),
        sessionId: delta.sessionId,
        generation: delta.generation,
        fromSequence: delta.sequence,
        toSequence: delta.sequence,
      };
      this.queues.set(botId, queue);
    }
    if (delta.kind === 'reset') {
      queue.deltas.clear();
      queue.fromSequence = delta.sequence;
    }
    queue.generation = delta.generation;
    queue.toSequence = Math.max(queue.toSequence, delta.sequence);
    queue.deltas.set(deltaKey(delta), delta);
    const limit = Math.max(1, this.limits().maxDeltaBatchEntries);
    if (queue.deltas.size >= limit) {
      this.flush(botId);
      return;
    }
    if (!this.timers.has(botId)) {
      const delay = Math.max(0, this.limits().deltaBatchMs);
      this.timers.set(botId, setTimeout(() => this.flush(botId), delay));
    }
  }

  flush(botId: string): void {
    const timer = this.timers.get(botId);
    if (timer) clearTimeout(timer);
    this.timers.delete(botId);
    const queue = this.queues.get(botId);
    this.queues.delete(botId);
    if (!queue?.deltas.size) return;
    this.send(botId, {
      protocol: 'mineclaw.visual-world-delta/v1',
      sessionId: queue.sessionId,
      generation: queue.generation,
      fromSequence: queue.fromSequence,
      toSequence: queue.toSequence,
      deltas: Array.from(queue.deltas.values()).sort((left, right) => left.sequence - right.sequence),
      createdAt: Date.now(),
    });
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queues.clear();
  }
}

function deltaKey(delta: VisualWorldDelta): string {
  switch (delta.kind) {
    case 'block': return `block:${delta.position.x},${delta.position.y},${delta.position.z}`;
    case 'column_replace':
    case 'column_unload': return `column:${delta.chunkX},${delta.chunkZ}`;
    case 'entity_upsert': return `entity:${delta.entity.id}`;
    case 'entity_remove': return `entity:${delta.entityId}`;
    case 'environment': return 'environment';
    case 'resource_pack': return 'resource_pack';
    case 'reset': return 'reset';
  }
}
