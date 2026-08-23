export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  version?: string;
  auth: 'offline' | 'microsoft';
  reconnect: ReconnectConfig;
}

export interface SkinSyncStatus {
  state: 'idle' | 'pending' | 'synced' | 'unsupported' | 'failed';
  adapterId?: 'skinsrestorer';
  skinDigest?: string;
  reasonCode?: string;
  message?: string;
  updatedAt: number;
}

export interface ReconnectConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export type GameEventType =
  | 'chat'
  | 'whisper'
  | 'spawn'
  | 'death'
  | 'health_change'
  | 'entity_spawn'
  | 'entity_gone'
  | 'kicked'
  | 'error'
  | 'connection_change';

export interface GameEvent {
  type: GameEventType;
  timestamp: number;
  data: Record<string, unknown>;
}
