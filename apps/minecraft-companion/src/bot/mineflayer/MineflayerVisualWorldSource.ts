import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import type { PCChunk } from 'prismarine-chunk';
import { Vec3 } from 'vec3';
import { randomUUID } from 'node:crypto';
import type {
  VisualBiome,
  VisualBlockState,
  VisualEntity,
  VisualEnvironment,
  VisualSection,
  VisualServerPackOffer,
  VisualWorldBootstrap,
  VisualWorldDelta,
  VisualWorldSnapshotOptions,
  VisualWorldSource,
} from '../adapter/VisualWorldSource.js';

type VisualRegistry = {
  blocksByStateId?: Record<number, { name?: string }>;
  biomes?: Record<number, { name?: string }>;
  biomesById?: Record<number, { name?: string }>;
};

type VisualGameState = Bot['game'] & { minY?: number; height?: number };
type VisualDeltaInput = VisualWorldDelta extends infer Delta
  ? Delta extends VisualWorldDelta
    ? Omit<Delta, 'sessionId' | 'generation' | 'sequence' | 'timestamp'>
    : never
  : never;
type LooseBotEmitter = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

type VisualWindowCenter = { chunkX: number; chunkZ: number };

export class MineflayerVisualWorldSource implements VisualWorldSource {
  private bot: Bot | null = null;
  private generation = 0;
  private sequence = 0;
  private sessionId = randomUUID();
  private serverResourcePack: VisualServerPackOffer | null = null;
  private readonly listeners = new Set<(delta: VisualWorldDelta) => void>();
  private readonly boundListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];
  private readonly columnEpoch = new Map<string, number>();
  private readonly visibleEntityIds = new Set<number>();
  private snapshotOptions: VisualWorldSnapshotOptions | null = null;
  private windowCenter: VisualWindowCenter | null = null;

  rebind(bot: Bot | null): void {
    this.detachBotListeners();
    this.bot = bot;
    this.generation += 1;
    this.sequence = 0;
    this.sessionId = randomUUID();
    this.serverResourcePack = null;
    this.columnEpoch.clear();
    this.visibleEntityIds.clear();
    this.windowCenter = null;
    if (bot && this.listeners.size > 0) this.attachBotListeners(bot);
    this.emit({ kind: 'reset', reason: 'connection_rebind' });
  }

  isAvailable(): boolean {
    return this.bot !== null;
  }

  configure(options: VisualWorldSnapshotOptions): void {
    const next = normalizeSnapshotOptions(options);
    const previous = this.snapshotOptions;
    this.snapshotOptions = next;
    const bot = this.bot;
    if (!bot?.entity?.position || !this.windowCenter || !previous) return;
    const center = chunkCenterOf(bot.entity.position);
    if (previous.viewDistanceChunks !== next.viewDistanceChunks
      || center.chunkX !== this.windowCenter.chunkX
      || center.chunkZ !== this.windowCenter.chunkZ) {
      this.shiftWindow(bot, center, previous.viewDistanceChunks);
    }
  }

  subscribe(listener: (delta: VisualWorldDelta) => void): () => void {
    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);
    if (wasEmpty && this.bot) this.attachBotListeners(this.bot);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachBotListeners();
    };
  }

  async createBootstrap(options: VisualWorldSnapshotOptions): Promise<VisualWorldBootstrap | null> {
    const bot = this.bot;
    if (!bot?.entity?.position) return null;
    this.configure(options);
    const generation = this.generation;
    const sessionId = this.sessionId;
    const snapshotSequence = this.sequence;
    const game = bot.game as VisualGameState;
    const minY = Number.isFinite(game.minY) ? Number(game.minY) : 0;
    const height = Number.isFinite(game.height) ? Number(game.height) : 256;
    const center = chunkCenterOf(bot.entity.position);
    if (!this.windowCenter) this.windowCenter = center;
    else if (center.chunkX !== this.windowCenter.chunkX || center.chunkZ !== this.windowCenter.chunkZ) {
      this.shiftWindow(bot, center, this.snapshotOptions?.viewDistanceChunks ?? options.viewDistanceChunks);
    }
    const effectiveOptions = this.snapshotOptions ?? normalizeSnapshotOptions(options);
    const columns = bot.world.getColumns()
      .filter(({ chunkX, chunkZ }) => isChunkInWindow(chunkX, chunkZ, center, effectiveOptions.viewDistanceChunks))
      .sort((left, right) => chunkDistanceSq(left, center) - chunkDistanceSq(right, center));
    const sections: VisualSection[] = [];
    for (const entry of columns) {
      for (let sectionY = Math.floor(minY / 16); sectionY < Math.ceil((minY + height) / 16); sectionY++) {
        if (this.bot !== bot || this.generation !== generation || this.sessionId !== sessionId) return null;
        const section = encodeVisualSection(entry.column as PCChunk, bot.registry as VisualRegistry, entry.chunkX, sectionY, entry.chunkZ);
        if (section.nonAirBlocks > 0) sections.push(section);
        await yieldToEventLoop();
      }
    }

    return {
      protocol: 'mineclaw.visual-world/v1',
      sessionId,
      generation,
      sequence: snapshotSequence,
      gameVersion: bot.version,
      minY,
      height,
      center,
      viewDistanceChunks: effectiveOptions.viewDistanceChunks,
      sections,
      entities: this.captureVisibleEntities(bot, effectiveOptions.entityRenderDistance),
      environment: toVisualEnvironment(bot),
      serverResourcePack: this.serverResourcePack,
      createdAt: Date.now(),
    };
  }

  private attachBotListeners(bot: Bot): void {
    this.bind(bot, 'blockUpdate', (_oldBlock: Block | null, newBlock: Block | null) => {
      if (!newBlock) return;
      const chunkX = Math.floor(newBlock.position.x / 16);
      const chunkZ = Math.floor(newBlock.position.z / 16);
      if (!this.isChunkVisible(chunkX, chunkZ)) return;
      const registry = bot.registry as VisualRegistry;
      this.emit({
        kind: 'block',
        position: copyVec(newBlock.position),
        state: blockToVisualState(newBlock, registry),
        blockLight: finiteLight(newBlock.light),
        skyLight: finiteLight(newBlock.skyLight),
        biome: biomeFromRegistry(registry, Number(newBlock.biome?.id ?? 0)),
      });
    });
    this.bind(bot, 'chunkColumnLoad', (corner: { x: number; z: number }) => {
      const chunkX = Math.floor(corner.x / 16);
      const chunkZ = Math.floor(corner.z / 16);
      if (!this.isChunkVisible(chunkX, chunkZ)) return;
      void this.replaceColumn(bot, chunkX, chunkZ);
    });
    this.bind(bot, 'chunkColumnUnload', (corner: { x: number; z: number }) => {
      const chunkX = Math.floor(corner.x / 16);
      const chunkZ = Math.floor(corner.z / 16);
      this.bumpColumnEpoch(chunkX, chunkZ);
      if (!this.isChunkVisible(chunkX, chunkZ)) return;
      this.emit({ kind: 'column_unload', chunkX, chunkZ });
    });
    const upsert = (entity: Entity) => this.upsertVisibleEntity(bot, entity);
    this.bind(bot, 'entitySpawn', upsert);
    this.bind(bot, 'entityMoved', upsert);
    this.bind(bot, 'entityUpdate', upsert);
    this.bind(bot, 'entityEquip', upsert);
    this.bind(bot, 'entityGone', (entity: Entity) => {
      if (!this.visibleEntityIds.delete(entity.id)) return;
      this.emit({ kind: 'entity_remove', entityId: entity.id });
    });
    this.bind(bot, 'move', () => {
      if (!bot.entity?.position || !this.windowCenter || !this.snapshotOptions) return;
      const center = chunkCenterOf(bot.entity.position);
      if (center.chunkX === this.windowCenter.chunkX && center.chunkZ === this.windowCenter.chunkZ) return;
      this.shiftWindow(bot, center, this.snapshotOptions.viewDistanceChunks);
    });
    this.bind(bot, 'time', () => this.emit({ kind: 'environment', environment: toVisualEnvironment(bot) }));
    this.bind(bot, 'weatherUpdate', () => this.emit({ kind: 'environment', environment: toVisualEnvironment(bot) }));
    this.bind(bot, 'resourcePack', (url: string, hash?: string, uuid?: string) => {
      const offer = { url, hash, uuid };
      this.serverResourcePack = offer;
      this.emit({ kind: 'resource_pack', offer });
    });
    this.bind(bot, 'game', () => {
      this.generation += 1;
      this.sequence = 0;
      this.sessionId = randomUUID();
      this.columnEpoch.clear();
      this.visibleEntityIds.clear();
      this.windowCenter = null;
      this.emit({ kind: 'reset', reason: 'dimension_change' });
    });
  }

  private async replaceColumn(bot: Bot, chunkX: number, chunkZ: number): Promise<void> {
    if (!this.isChunkVisible(chunkX, chunkZ)) return;
    const generation = this.generation;
    const epoch = this.bumpColumnEpoch(chunkX, chunkZ);
    await yieldToEventLoop();
    const column = bot.world.getColumn(chunkX, chunkZ) as PCChunk | null;
    if (!column || this.bot !== bot || generation !== this.generation || epoch !== this.currentColumnEpoch(chunkX, chunkZ)
      || !this.isChunkVisible(chunkX, chunkZ)) return;
    const game = bot.game as VisualGameState;
    const minY = Number.isFinite(game.minY) ? Number(game.minY) : 0;
    const height = Number.isFinite(game.height) ? Number(game.height) : 256;
    const sections: VisualSection[] = [];
    for (let sectionY = Math.floor(minY / 16); sectionY < Math.ceil((minY + height) / 16); sectionY++) {
      const section = encodeVisualSection(column, bot.registry as VisualRegistry, chunkX, sectionY, chunkZ);
      if (section.nonAirBlocks > 0) sections.push(section);
      await yieldToEventLoop();
      if (this.bot !== bot || generation !== this.generation || epoch !== this.currentColumnEpoch(chunkX, chunkZ)
        || !this.isChunkVisible(chunkX, chunkZ)) return;
    }
    this.emit({ kind: 'column_replace', chunkX, chunkZ, sections });
  }

  private isChunkVisible(chunkX: number, chunkZ: number): boolean {
    return Boolean(this.windowCenter && this.snapshotOptions
      && isChunkInWindow(chunkX, chunkZ, this.windowCenter, this.snapshotOptions.viewDistanceChunks));
  }

  private shiftWindow(bot: Bot, nextCenter: VisualWindowCenter, previousRadius: number): void {
    const previousCenter = this.windowCenter;
    const nextRadius = this.snapshotOptions?.viewDistanceChunks ?? previousRadius;
    this.windowCenter = nextCenter;
    if (!previousCenter) return;
    forEachWindowChunk(previousCenter, previousRadius, (chunkX, chunkZ) => {
      if (isChunkInWindow(chunkX, chunkZ, nextCenter, nextRadius)) return;
      this.bumpColumnEpoch(chunkX, chunkZ);
      this.emit({ kind: 'column_unload', chunkX, chunkZ });
    });
    forEachWindowChunk(nextCenter, nextRadius, (chunkX, chunkZ) => {
      if (isChunkInWindow(chunkX, chunkZ, previousCenter, previousRadius)) return;
      void this.replaceColumn(bot, chunkX, chunkZ);
    });
    this.syncVisibleEntities(bot);
  }

  private captureVisibleEntities(bot: Bot, renderDistance: number): VisualEntity[] {
    const entities = Object.values(bot.entities)
      .map(entity => toVisualEntity(entity, bot))
      .filter(entity => distanceSq(entity.position, bot.entity.position) <= renderDistance ** 2);
    this.visibleEntityIds.clear();
    for (const entity of entities) this.visibleEntityIds.add(entity.id);
    return entities;
  }

  private upsertVisibleEntity(bot: Bot, entity: Entity): void {
    const renderDistance = this.snapshotOptions?.entityRenderDistance;
    if (!renderDistance || !bot.entity?.position) return;
    const visual = toVisualEntity(entity, bot);
    if (distanceSq(visual.position, bot.entity.position) <= renderDistance ** 2) {
      this.visibleEntityIds.add(entity.id);
      this.emit({ kind: 'entity_upsert', entity: visual });
      return;
    }
    if (this.visibleEntityIds.delete(entity.id)) this.emit({ kind: 'entity_remove', entityId: entity.id });
  }

  private syncVisibleEntities(bot: Bot): void {
    const renderDistance = this.snapshotOptions?.entityRenderDistance;
    if (!renderDistance || !bot.entity?.position) return;
    const nextVisible = new Set<number>();
    for (const entity of Object.values(bot.entities)) {
      const visual = toVisualEntity(entity, bot);
      if (distanceSq(visual.position, bot.entity.position) > renderDistance ** 2) continue;
      nextVisible.add(entity.id);
      this.emit({ kind: 'entity_upsert', entity: visual });
    }
    for (const entityId of this.visibleEntityIds) {
      if (!nextVisible.has(entityId)) this.emit({ kind: 'entity_remove', entityId });
    }
    this.visibleEntityIds.clear();
    for (const entityId of nextVisible) this.visibleEntityIds.add(entityId);
  }

  private bind<Args extends unknown[]>(bot: Bot, event: string, listener: (...args: Args) => void): void {
    const erased = listener as (...args: unknown[]) => void;
    (bot as unknown as LooseBotEmitter).on(event, erased);
    this.boundListeners.push({ event, listener: erased });
  }

  private detachBotListeners(): void {
    const bot = this.bot;
    if (bot) for (const { event, listener } of this.boundListeners) {
      (bot as unknown as LooseBotEmitter).removeListener(event, listener);
    }
    this.boundListeners.length = 0;
  }

  private emit(delta: VisualDeltaInput): void {
    const full = {
      ...delta,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: ++this.sequence,
      timestamp: Date.now(),
    } as VisualWorldDelta;
    for (const listener of this.listeners) listener(full);
  }

  private bumpColumnEpoch(chunkX: number, chunkZ: number): number {
    const key = `${chunkX},${chunkZ}`;
    const next = (this.columnEpoch.get(key) ?? 0) + 1;
    this.columnEpoch.set(key, next);
    return next;
  }

  private currentColumnEpoch(chunkX: number, chunkZ: number): number {
    return this.columnEpoch.get(`${chunkX},${chunkZ}`) ?? 0;
  }
}

export function encodeVisualSection(
  column: Pick<PCChunk, 'getBlockStateId' | 'getBlock' | 'getBlockLight' | 'getSkyLight' | 'getBiome'>,
  registry: VisualRegistry,
  chunkX: number,
  sectionY: number,
  chunkZ: number,
): VisualSection {
  const palette: VisualBlockState[] = [];
  const paletteByState = new Map<number, number>();
  const biomePalette: VisualBiome[] = [];
  const paletteByBiome = new Map<number, number>();
  const indices = new Uint16Array(4096);
  const blockLight = new Uint8Array(4096);
  const skyLight = new Uint8Array(4096);
  const biomeIndices = new Uint16Array(4096);
  let nonAirBlocks = 0;

  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const index = (y * 16 + z) * 16 + x;
    const position = new Vec3(x, sectionY * 16 + y, z);
    const stateId = safeNumber(() => column.getBlockStateId(position), 0);
    let stateIndex = paletteByState.get(stateId);
    if (stateIndex === undefined) {
      stateIndex = palette.length;
      paletteByState.set(stateId, stateIndex);
      let block: Block | null = null;
      try { block = column.getBlock(position); } catch { /* sparse/unlit section */ }
      palette.push(blockToVisualState(block, registry, stateId));
    }
    indices[index] = stateIndex;
    if (!isAirName(palette[stateIndex].name)) nonAirBlocks += 1;
    blockLight[index] = safeNumber(() => column.getBlockLight(position), 0);
    skyLight[index] = safeNumber(() => column.getSkyLight(position), 15);
    const biomeId = safeNumber(() => Number(column.getBiome(position)), 0);
    let biomeIndex = paletteByBiome.get(biomeId);
    if (biomeIndex === undefined) {
      biomeIndex = biomePalette.length;
      paletteByBiome.set(biomeId, biomeIndex);
      biomePalette.push(biomeFromRegistry(registry, biomeId));
    }
    biomeIndices[index] = biomeIndex;
  }

  return {
    key: `${chunkX},${sectionY},${chunkZ}`,
    chunkX,
    sectionY,
    chunkZ,
    palette,
    indices,
    blockLight,
    skyLight,
    biomePalette,
    biomeIndices,
    nonAirBlocks,
  };
}

function blockToVisualState(block: Block | null, registry: VisualRegistry, fallbackStateId = 0): VisualBlockState {
  const stateId = Number.isInteger(block?.stateId) ? block!.stateId : fallbackStateId;
  const registryName = registry.blocksByStateId?.[stateId]?.name;
  const rawProperties = block?.getProperties?.() ?? {};
  return {
    stateId,
    name: block?.name ?? registryName ?? (stateId === 0 ? 'air' : `unknown_${stateId}`),
    properties: Object.fromEntries(Object.entries(rawProperties).map(([key, value]) => [key, String(value)])),
  };
}

function biomeFromRegistry(registry: VisualRegistry, id: number): VisualBiome {
  return { id, name: registry.biomes?.[id]?.name ?? registry.biomesById?.[id]?.name ?? `unknown_${id}` };
}

function toVisualEntity(entity: Entity, bot?: Bot): VisualEntity {
  const skinData = entity.username ? bot?.players?.[entity.username]?.skinData : undefined;
  let droppedItemName: string | undefined;
  try { droppedItemName = entity.getDroppedItem()?.name; } catch { /* metadata may not be ready yet */ }
  return {
    id: entity.id,
    type: entity.type ?? 'other',
    name: entity.username ?? entity.name ?? entity.mobType ?? entity.displayName ?? 'unknown',
    username: entity.username,
    skinUrl: skinData?.url,
    skinModel: skinData?.model === 'slim' ? 'slim' : (skinData ? 'classic' : undefined),
    isSelf: entity.id === bot?.entity?.id,
    itemName: droppedItemName,
    position: copyVec(entity.position),
    velocity: copyVec(entity.velocity),
    yaw: finite(entity.yaw),
    pitch: finite(entity.pitch),
    width: finite(entity.width, 0.6),
    height: finite(entity.height, 1.8),
    onGround: entity.onGround === true,
    equipment: Array.from(entity.equipment ?? [], item => item?.name ?? null),
  };
}

function toVisualEnvironment(bot: Bot): VisualEnvironment {
  const timeOfDay = finite(bot.time?.timeOfDay);
  return {
    dimension: bot.game?.dimension ?? 'overworld',
    timeOfDay,
    isDay: timeOfDay < 13_000 || timeOfDay > 23_000,
    isRaining: bot.isRaining === true,
    thunderState: finite(bot.thunderState),
  };
}

function copyVec(value: { x?: number; y?: number; z?: number } | null | undefined) {
  return { x: finite(value?.x), y: finite(value?.y), z: finite(value?.z) };
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteLight(value: unknown): number {
  return Math.min(15, Math.max(0, Math.round(finite(value))));
}

function safeNumber(read: () => number, fallback: number): number {
  try { return finite(read(), fallback); } catch { return fallback; }
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air';
}

function chunkDistanceSq(entry: { chunkX: number; chunkZ: number }, center: { chunkX: number; chunkZ: number }): number {
  return (entry.chunkX - center.chunkX) ** 2 + (entry.chunkZ - center.chunkZ) ** 2;
}

function normalizeSnapshotOptions(options: VisualWorldSnapshotOptions): VisualWorldSnapshotOptions {
  return {
    viewDistanceChunks: Math.max(1, Math.floor(finite(options.viewDistanceChunks, 3))),
    entityRenderDistance: Math.max(1, finite(options.entityRenderDistance, 96)),
  };
}

function chunkCenterOf(position: { x: number; z: number }): VisualWindowCenter {
  return { chunkX: Math.floor(position.x / 16), chunkZ: Math.floor(position.z / 16) };
}

function isChunkInWindow(chunkX: number, chunkZ: number, center: VisualWindowCenter, radius: number): boolean {
  return Math.abs(chunkX - center.chunkX) <= radius && Math.abs(chunkZ - center.chunkZ) <= radius;
}

function forEachWindowChunk(center: VisualWindowCenter, radius: number, visit: (chunkX: number, chunkZ: number) => void): void {
  for (let chunkX = center.chunkX - radius; chunkX <= center.chunkX + radius; chunkX++) {
    for (let chunkZ = center.chunkZ - radius; chunkZ <= center.chunkZ + radius; chunkZ++) visit(chunkX, chunkZ);
  }
}

function distanceSq(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
