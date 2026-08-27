import type { Unsubscribe, Vec3 } from './types.js';

export interface VisualBlockState {
  stateId: number;
  name: string;
  properties: Record<string, string>;
}

export interface VisualBiome {
  id: number;
  name: string;
}

export interface VisualSection {
  key: string;
  chunkX: number;
  sectionY: number;
  chunkZ: number;
  palette: VisualBlockState[];
  /** 16×16×16，索引顺序为 y-z-x；Socket.IO 以二进制附件传输。 */
  indices: Uint16Array;
  blockLight: Uint8Array;
  skyLight: Uint8Array;
  biomePalette: VisualBiome[];
  biomeIndices: Uint16Array;
  nonAirBlocks: number;
}

export interface VisualEntity {
  id: number;
  type: string;
  name: string;
  username?: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  width: number;
  height: number;
  onGround: boolean;
  equipment: Array<string | null>;
}

export interface VisualEnvironment {
  dimension: string;
  timeOfDay: number;
  isDay: boolean;
  isRaining: boolean;
  thunderState: number;
}

export interface VisualServerPackOffer {
  url: string;
  hash?: string;
  uuid?: string;
}

export interface VisualWorldBootstrap {
  protocol: 'mineclaw.visual-world/v1';
  sessionId: string;
  generation: number;
  sequence: number;
  gameVersion: string;
  minY: number;
  height: number;
  center: { chunkX: number; chunkZ: number };
  viewDistanceChunks: number;
  sections: VisualSection[];
  entities: VisualEntity[];
  environment: VisualEnvironment;
  serverResourcePack: VisualServerPackOffer | null;
  createdAt: number;
}

export interface VisualWorldSnapshotOptions {
  viewDistanceChunks: number;
  entityRenderDistance: number;
}

export type VisualWorldDelta =
  | { kind: 'block'; sessionId: string; generation: number; sequence: number; timestamp: number; position: Vec3; state: VisualBlockState; blockLight: number; skyLight: number; biome: VisualBiome }
  | { kind: 'column_replace'; sessionId: string; generation: number; sequence: number; timestamp: number; chunkX: number; chunkZ: number; sections: VisualSection[] }
  | { kind: 'column_unload'; sessionId: string; generation: number; sequence: number; timestamp: number; chunkX: number; chunkZ: number }
  | { kind: 'entity_upsert'; sessionId: string; generation: number; sequence: number; timestamp: number; entity: VisualEntity }
  | { kind: 'entity_remove'; sessionId: string; generation: number; sequence: number; timestamp: number; entityId: number }
  | { kind: 'environment'; sessionId: string; generation: number; sequence: number; timestamp: number; environment: VisualEnvironment }
  | { kind: 'resource_pack'; sessionId: string; generation: number; sequence: number; timestamp: number; offer: VisualServerPackOffer }
  | { kind: 'reset'; sessionId: string; generation: number; sequence: number; timestamp: number; reason: 'dimension_change' | 'connection_rebind' };

export interface VisualWorldSource {
  isAvailable(): boolean;
  createBootstrap(options: VisualWorldSnapshotOptions): Promise<VisualWorldBootstrap | null>;
  subscribe(listener: (delta: VisualWorldDelta) => void): Unsubscribe;
}
