/**
 * Persistent registry generation, pending-reference rebuild and cross-build
 * upgrade preflight (kernel design §5.6).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActiveGenerationRecord, PublishedGenerationSet, PublishedGenerationSlot } from './registration.js';
import type { RegistrySnapshotRef } from '../plugin-sdk/identity.js';
import { pluginError } from '../plugin-sdk/errors.js';

export interface GenerationPersistence {
  save(record: ActiveGenerationRecord): void;
  loadLatest(): ActiveGenerationRecord | null;
}

/** File-backed persistence for the durable generation ledger. */
export class JsonGenerationStore implements GenerationPersistence {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  save(record: ActiveGenerationRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const serializable = {
      generationId: record.generationId,
      baseGenerationId: record.baseGenerationId,
      parentGenerationId: record.parentGenerationId,
      createdAt: record.createdAt,
      buildId: record.buildId,
      manifests: record.manifests.map((manifest) => JSON.parse(JSON.stringify(manifest))),
      registry: {
        ids: [...record.registry.byId.keys()],
        byKind: Object.fromEntries([...record.registry.byKind.entries()]),
      },
      permissions: [...record.permissions.keys()],
      graphHash: record.graphHash,
    };
    writeFileSync(this.file, JSON.stringify(serializable), 'utf8');
  }

  loadLatest(): ActiveGenerationRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        generationId: string; baseGenerationId: string | null; parentGenerationId: string | null;
        createdAt: string; buildId: string; graphHash: string;
        manifests: Array<Record<string, unknown>>; registry: { ids: string[] };
      };
      return Object.freeze({
        generationId: parsed.generationId,
        baseGenerationId: parsed.baseGenerationId,
        parentGenerationId: parsed.parentGenerationId,
        createdAt: parsed.createdAt,
        buildId: parsed.buildId,
        manifests: Object.freeze(parsed.manifests.map((manifest) => Object.freeze(manifest))),
        registry: Object.freeze({
          byId: new Map<string, never>(),
          byKind: new Map(),
          disabledIds: Object.freeze([]),
        }),
        permissions: new Map(),
        graphHash: parsed.graphHash,
      }) as unknown as ActiveGenerationRecord;
    } catch {
      return null;
    }
  }
}

/** Pending-reference ledger rebuilt from non-terminal goals and unresolved ledger records. */
export class ReferenceLedger {
  private readonly pending = new Map<string, Set<string>>();

  reference(snapshot: RegistrySnapshotRef, entityId: string): void {
    const bucket = this.pending.get(snapshot.generationId) ?? new Set<string>();
    bucket.add(entityId);
    this.pending.set(snapshot.generationId, bucket);
  }

  release(snapshot: RegistrySnapshotRef, entityId: string): void {
    const bucket = this.pending.get(snapshot.generationId);
    if (!bucket) return;
    bucket.delete(entityId);
    if (bucket.size === 0) this.pending.delete(snapshot.generationId);
  }

  pendingCount(snapshot: RegistrySnapshotRef): number {
    return this.pending.get(snapshot.generationId)?.size ?? 0;
  }

  /** Rebuild immutable reference counts from durable non-terminal sources. */
  rebuild(sources: readonly { readonly generationId: string; readonly entityId: string }[]): void {
    this.pending.clear();
    for (const source of sources) {
      const bucket = this.pending.get(source.generationId) ?? new Set<string>();
      bucket.add(source.entityId);
      this.pending.set(source.generationId, bucket);
    }
  }

  pendingGenerationIds(): readonly string[] {
    return Object.freeze([...this.pending.keys()]);
  }
}

export interface UpgradeDecision {
  readonly decision: 'allowed' | 'blocked';
  readonly reason?: string;
}

/**
 * Same-build restarts restore the durable generation; a cross-build upgrade with
 * non-terminal references is blocked. Bypassing the guard leaves the old records
 * needs_rebind/in_doubt (the resolvers refuse to hand them to new implementations).
 */
export function preflightBuildUpgrade(
  currentBuildId: string,
  proposedBuildId: string,
  pendingRefs: readonly RegistrySnapshotRef[],
): UpgradeDecision {
  if (currentBuildId === proposedBuildId) return Object.freeze({ decision: 'allowed' });
  if (pendingRefs.length === 0) return Object.freeze({ decision: 'allowed' });
  return Object.freeze({
    decision: 'blocked',
    reason: `${pendingRefs.length} non-terminal reference(s) still pin the previous build ${currentBuildId}; drain or rebind before switching to ${proposedBuildId}`,
  });
}

/** Maintainer that removes a drained generation once its references are zero and retracts its gate. */
export class GenerationSetMaintainer {
  private readonly slot: PublishedGenerationSlot;
  private readonly ledger: ReferenceLedger;
  private readonly retract: (generationId: string) => void;

  constructor(slot: PublishedGenerationSlot, ledger: ReferenceLedger, retract: (generationId: string) => void) {
    this.slot = slot;
    this.ledger = ledger;
    this.retract = retract;
  }

  releaseAndMaybeEvict(snapshot: RegistrySnapshotRef, entityId: string): boolean {
    this.ledger.release(snapshot, entityId);
    if (this.ledger.pendingCount(snapshot) > 0) return false;
    const current = this.slot.read();
    const record = current.drainingById.get(snapshot.generationId);
    if (!record) return false;
    const nextDraining = new Map(current.drainingById);
    nextDraining.delete(snapshot.generationId);
    const next = { ...current, drainingById: nextDraining };
    if (!this.slot.compareAndSwap(current, next)) {
      throw pluginError('generation_conflict', 'draining eviction lost a concurrent publication');
    }
    this.retract(snapshot.generationId);
    return true;
  }
}
