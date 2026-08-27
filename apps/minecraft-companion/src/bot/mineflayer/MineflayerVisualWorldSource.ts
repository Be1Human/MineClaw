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

export class MineflayerVisualWorldSource implements VisualWorldSource {
  private bot: Bot | null = null;
  private generation = 0;
  private sequence = 0;
  private sessionId = randomUUID();
  private serverResourcePack: VisualServerPackOffer | null = null;
  private readonly listeners = new Set<(delta: VisualWorldDelta) => void>();
  private readonly boundListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];
  private readonly columnEpoch = new Map<string, number>();

  rebind(bot: Bot | null): void {
    this.detachBotListeners();
    this.bot = bot;
    this.generation += 1;
    this.sequence = 0;
    this.sessionId = randomUUID();
    this.serverResourcePack = null;
    this.columnEpoch.clear();
    if (bot && this.listeners.size > 0) this.attachBotListeners(bot);
    this.emit({ kind: 'reset', reason: 'connection_rebind' });
  }

  isAvailable(): boolean {
    return this.bot !== null;
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
    const generation = this.generation;
    const sessionId = this.sessionId;
    const snapshotSequence = this.sequence;
    const game = bot.game as VisualGameState;
    const minY = Number.isFinite(game.minY) ? Number(game.minY) : 0;
    const height = Number.isFinite(game.height) ? Number(game.height) : 256;
    const center = {
      chunkX: Math.floor(bot.entity.position.x / 16),
      chunkZ: Math.floor(bot.entity.position.z / 16),
    };
    const columns = bot.world.getColumns()
      .filter(({ chunkX, chunkZ }) => Math.abs(chunkX - center.chunkX) <= options.viewDistanceChunks
        && Math.abs(chunkZ - center.chunkZ) <= options.viewDistanceChunks)
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
      viewDistanceChunks: options.viewDistanceChunks,
      sections,
      entities: Object.values(bot.entities)
        .map(entity => toVisualEntity(entity))
        .filter(entity => distanceSq(entity.position, bot.entity.position) <= options.entityRenderDistance ** 2),
      environment: toVisualEnvironment(bot),
      serverResourcePack: this.serverResourcePack,
      createdAt: Date.now(),
    };
  }

  private attachBotListeners(bot: Bot): void {
    this.bind(bot, 'blockUpdate', (_oldBlock: Block | null, newBlock: Block | null) => {
      if (!newBlock) return;
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
      void this.replaceColumn(bot, chunkX, chunkZ);
    });
    this.bind(bot, 'chunkColumnUnload', (corner: { x: number; z: number }) => {
      const chunkX = Math.floor(corner.x / 16);
      const chunkZ = Math.floor(corner.z / 16);
      this.bumpColumnEpoch(chunkX, chunkZ);
      this.emit({ kind: 'column_unload', chunkX, chunkZ });
    });
    const upsert = (entity: Entity) => this.emit({ kind: 'entity_upsert', entity: toVisualEntity(entity) });
    this.bind(bot, 'entitySpawn', upsert);
    this.bind(bot, 'entityMoved', upsert);
    this.bind(bot, 'entityUpdate', upsert);
    this.bind(bot, 'entityEquip', upsert);
    this.bind(bot, 'entityGone', (entity: Entity) => this.emit({ kind: 'entity_remove', entityId: entity.id }));
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
      this.emit({ kind: 'reset', reason: 'dimension_change' });
    });
  }

  private async replaceColumn(bot: Bot, chunkX: number, chunkZ: number): Promise<void> {
    const generation = this.generation;
    const epoch = this.bumpColumnEpoch(chunkX, chunkZ);
    await yieldToEventLoop();
    const column = bot.world.getColumn(chunkX, chunkZ) as PCChunk | null;
    if (!column || this.bot !== bot || generation !== this.generation || epoch !== this.currentColumnEpoch(chunkX, chunkZ)) return;
    const game = bot.game as VisualGameState;
    const minY = Number.isFinite(game.minY) ? Number(game.minY) : 0;
    const height = Number.isFinite(game.height) ? Number(game.height) : 256;
    const sections: VisualSection[] = [];
    for (let sectionY = Math.floor(minY / 16); sectionY < Math.ceil((minY + height) / 16); sectionY++) {
      const section = encodeVisualSection(column, bot.registry as VisualRegistry, chunkX, sectionY, chunkZ);
      if (section.nonAirBlocks > 0) sections.push(section);
      await yieldToEventLoop();
      if (this.bot !== bot || generation !== this.generation || epoch !== this.currentColumnEpoch(chunkX, chunkZ)) return;
    }
    this.emit({ kind: 'column_replace', chunkX, chunkZ, sections });
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
  return { id, name: registry.biomesById?.[id]?.name ?? `unknown_${id}` };
}

function toVisualEntity(entity: Entity): VisualEntity {
  return {
    id: entity.id,
    type: entity.type ?? 'other',
    name: entity.username ?? entity.name ?? entity.mobType ?? entity.displayName ?? 'unknown',
    username: entity.username,
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

function distanceSq(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
