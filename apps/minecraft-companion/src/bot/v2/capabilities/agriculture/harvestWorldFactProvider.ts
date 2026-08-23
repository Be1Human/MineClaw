import type { GameAdapter } from '../../../adapter/GameAdapter.js';
import type { Vec3 } from '../../../adapter/types.js';
import type { CapabilityWorldFact, CapabilityWorldFactProvider } from '../types.js';

export interface MatureCropFact {
  readonly cropId: 'wheat';
  readonly blockName: 'wheat';
  readonly position: Vec3;
  readonly age: number;
  readonly distance: number;
  readonly evidenceRef: string;
}

export interface HarvestDropFact {
  readonly entityId: number;
  readonly item: 'wheat' | 'wheat_seeds';
  readonly count: number;
  readonly position: Vec3;
  readonly distance: number;
  readonly evidenceRef: string;
}

export interface HarvestWorldFactValue {
  readonly matureCrops: readonly MatureCropFact[];
  readonly groundDrops: readonly HarvestDropFact[];
  readonly inventory: Readonly<Record<'wheat' | 'wheat_seeds', number>>;
}

const HARVEST_ITEMS = new Set(['wheat', 'wheat_seeds']);

export class HarvestWorldFactProvider implements CapabilityWorldFactProvider<HarvestWorldFactValue> {
  readonly id = 'agriculture.harvest_world';

  constructor(private readonly game: Pick<
    GameAdapter,
    'findBlocks' | 'getBlockProperties' | 'getEntities' | 'getInventoryItems'
  >) {}

  observe(input: Parameters<CapabilityWorldFactProvider<HarvestWorldFactValue>['observe']>[0]): CapabilityWorldFact<HarvestWorldFactValue> {
    if (input.signal?.aborted) throw abortError();
    const radius = boundedInteger(input.params?.radius, 32, 4, 64);
    const limit = boundedInteger(input.params?.limit, 128, 1, 256);
    const dropLimit = boundedInteger(input.params?.dropLimit, 128, 1, 256);
    const origin = input.world.self.position;
    const positions = this.game.findBlocks({ names: 'wheat', maxDistance: radius, count: limit + 1, origin });
    const truncatedCrops = positions.length > limit;
    const matureCrops = positions.slice(0, limit).flatMap(position => {
      const age = Number(this.game.getBlockProperties(position)?.age);
      if (age !== 7) return [];
      const distance = distanceBetween(origin, position);
      return [{
        cropId: 'wheat' as const,
        blockName: 'wheat' as const,
        position: structuredClone(position),
        age,
        distance,
        evidenceRef: `crop:wheat:${positionKey(position)}:age=7`,
      }];
    }).sort((left, right) => left.distance - right.distance || left.evidenceRef.localeCompare(right.evidenceRef));

    const drops = this.game.getEntities().flatMap(entity => {
      const item = entity.droppedItem?.name;
      if (!item || !HARVEST_ITEMS.has(item) || !entity.droppedItem || entity.droppedItem.count < 1) return [];
      const distance = distanceBetween(origin, entity.position);
      if (distance > radius) return [];
      return [{
        entityId: entity.id,
        item: item as HarvestDropFact['item'],
        count: entity.droppedItem.count,
        position: structuredClone(entity.position),
        distance,
        evidenceRef: `drop:${entity.id}:${item}:${entity.droppedItem.count}`,
      }];
    }).sort((left, right) => left.distance - right.distance || left.entityId - right.entityId);
    const truncatedDrops = drops.length > dropLimit;
    const inventory = { wheat: 0, wheat_seeds: 0 };
    for (const item of this.game.getInventoryItems()) {
      if (item.name === 'wheat' || item.name === 'wheat_seeds') inventory[item.name] += item.count;
    }
    const complete = !truncatedCrops && !truncatedDrops;
    return {
      providerId: this.id,
      observedAt: input.world.timestamp,
      complete,
      truncated: !complete,
      bounds: Object.freeze({ origin: structuredClone(origin), radius, cropLimit: limit, dropLimit }),
      value: Object.freeze({
        matureCrops: Object.freeze(matureCrops),
        groundDrops: Object.freeze(drops.slice(0, dropLimit)),
        inventory: Object.freeze(inventory),
      }),
      evidenceRefs: Object.freeze([
        `fact:${this.id}:mature=${matureCrops.length}`,
        `fact:${this.id}:drops=${Math.min(drops.length, dropLimit)}`,
        `fact:${this.id}:complete=${complete}`,
      ]),
    };
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function distanceBetween(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function positionKey(value: Vec3): string {
  return `${value.x}:${value.y}:${value.z}`;
}

function abortError(): Error {
  const error = new Error('harvest_world_observation_aborted');
  error.name = 'AbortError';
  return error;
}
