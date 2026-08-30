import type { FactStatus } from '../../infra/chatMemory.js';

export type MemorySlotValueType = 'scalar' | 'set' | 'enum' | 'date' | 'structured';
export type MemorySlotSensitivity = 'normal' | 'private' | 'restricted';
export type MemorySlotCapturePolicy = 'automatic' | 'corroborated' | 'explicit_only';
export type MemorySlotConflictPolicy = 'replace' | 'merge_set' | 'manual_review';
export type MemorySlotSourceKind = 'conversation' | 'explicit_tool' | 'manual_edit' | 'migration';

export interface MemorySlotDefinition {
  slotKey: string;
  catalogVersion: number;
  group: string;
  title: string;
  description: string;
  valueType: MemorySlotValueType;
  maxItems: number;
  sensitivity: MemorySlotSensitivity;
  capturePolicy: MemorySlotCapturePolicy;
  conflictPolicy: MemorySlotConflictPolicy;
  recallAliases: string[];
  promptPriority: 'P0' | 'P1' | 'P2' | 'P3';
}

export interface MemorySlotValue {
  id: string;
  profileId: string;
  slotKey: string;
  catalogVersion: number;
  value: unknown;
  normalizedKey: string;
  status: FactStatus;
  confidence: number;
  importance: number;
  sourceKind: MemorySlotSourceKind;
  sourceMessageIds: string[];
  supersedesId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySlotView {
  definition: MemorySlotDefinition;
  values: MemorySlotValue[];
}

export interface PutMemorySlotValueInput {
  slotKey: string;
  value: unknown;
  status?: 'active' | 'candidate';
  confidence?: number;
  importance?: number;
  sourceKind: MemorySlotSourceKind;
  sourceMessageIds: string[];
}
