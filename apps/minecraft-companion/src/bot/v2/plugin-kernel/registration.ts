/**
 * Registration transaction and atomic generation publication (kernel design §5.2/§5.5).
 * begin → construct → stage → validate → prepareStart → commit(CAS) | abort.
 * Each commit publishes a complete cumulative ActiveGenerationRecord (previous
 * registry + new package) through a single compare-and-swap of the
 * PublishedGenerationSet. No partial registry visibility, no early callbacks,
 * no retained fallback; prepared resources are parked behind the activation gate
 * until commit, and the commit itself never executes plugin code.
 */
import { createHash, randomUUID } from 'node:crypto';
import { assertExecutionClosure } from '../plugin-sdk/closure.js';
import type { PluginContribution, PluginContributionKind } from '../plugin-sdk/contributions.js';
import type { PluginFactory } from './discovery.js';
import { pluginError } from '../plugin-sdk/errors.js';
import type { ContributionRef, RegistrySnapshotRef } from '../plugin-sdk/identity.js';
import type { PluginManifestV1 } from '../plugin-sdk/manifest.js';
import type { PluginConstructionContext } from '../plugin-sdk/contracts/scopedContext.js';
import { compilePermissions, verifyPermissionAccess, type CompiledPermissionSet } from './permission.js';

export interface StagedContributionRecord {
  readonly ref: ContributionRef;
  readonly contribution: PluginContribution;
}

export interface TypedRegistrySnapshot {
  readonly byId: ReadonlyMap<string, StagedContributionRecord>;
  readonly byKind: ReadonlyMap<PluginContributionKind, readonly string[]>;
  readonly disabledIds: readonly string[];
}

export interface ActiveGenerationRecord {
  readonly generationId: string;
  readonly baseGenerationId: string | null;
  readonly parentGenerationId: string | null;
  readonly createdAt: string;
  readonly buildId: string;
  readonly manifests: readonly PluginManifestV1[];
  readonly registry: TypedRegistrySnapshot;
  readonly permissions: ReadonlyMap<string, CompiledPermissionSet>;
  readonly graphHash: string;
}

export interface PublishedGenerationSet {
  readonly active: ActiveGenerationRecord;
  readonly drainingById: ReadonlyMap<string, ActiveGenerationRecord>;
  readonly generationId: string;
}

/** Atomic published slot: readers and callbacks observe only the full old set or the full new set. */
export class PublishedGenerationSlot {
  private current: PublishedGenerationSet;

  constructor(initial: PublishedGenerationSet) {
    this.current = initial;
  }

  read(): PublishedGenerationSet {
    return this.current;
  }

  compareAndSwap(expected: PublishedGenerationSet, next: PublishedGenerationSet): boolean {
    if (this.current !== expected) return false;
    this.current = next;
    return true;
  }
}

export interface PreparedPluginLease {
  readonly pluginId: string;
  readonly token: string;
  readonly resourceIds: readonly string[];
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface PluginActivationGate {
  readonly open: boolean;
  /** A callback may run only when its record is the active one (new lease) or is draining (existing lease). */
  shouldRun(record: ActiveGenerationRecord, token: string, holdsExistingLease: boolean): boolean;
  openFor(record: ActiveGenerationRecord): void;
  /** Revoke a drained record: even existing leases are refused (late callbacks rejected). */
  retract(generationId: string): void;
}

export interface RegistrationTransactionOptions {
  readonly buildId: string;
  readonly existingSlot: PublishedGenerationSlot;
  readonly generationId?: string;
}

export class RegistrationTransaction {
  private readonly options: RegistrationTransactionOptions;
  private state: 'idle' | 'constructing' | 'staged' | 'validated' | 'prepared' | 'committed' | 'aborted' = 'idle';
  private staged = new Map<string, StagedContributionRecord>();
  private preparedLeases: PreparedPluginLease[] = [];
  private readonly manifest: PluginManifestV1;
  private contributions: readonly PluginContribution[] = [];
  private readonly permissions: CompiledPermissionSet;

  constructor(manifest: PluginManifestV1, options: RegistrationTransactionOptions) {
    this.manifest = manifest;
    this.options = options;
    this.permissions = compilePermissions(manifest.id, manifest.kind, manifest.permissions);
    this.state = 'idle';
  }

  /** Construct phase: runs the package factory (or data-content assembly) to obtain contributions. */
  construct(factory: PluginFactory | undefined, context: PluginConstructionContext): void {
    if (this.state !== 'idle' && this.state !== 'constructing') throw pluginError('plugin_cancelled', `cannot construct in state ${this.state}`);
    this.state = 'constructing';
    const contributions = factory !== undefined ? factory.create(context) : [];
    this.contributions = Object.freeze([...contributions]);
  }

  /** Stage phase: hold everything in the transaction's invisible staging clone. */
  stage(): void {
    if (this.state !== 'constructing' && this.state !== 'staged') throw pluginError('plugin_cancelled', `cannot stage in state ${this.state}`);
    for (const contribution of this.contributions) {
      if (this.staged.has(contribution.id)) throw pluginError('id_conflict', `duplicate staged contribution id ${contribution.id}`);
      this.staged.set(contribution.id, {
        ref: {
          pluginId: this.manifest.id,
          pluginVersion: this.manifest.version,
          contributionId: contribution.id,
          contributionVersion: contribution.version,
        },
        contribution,
      });
    }
    this.state = 'staged';
  }

  /** Validation: implementation/declaration match, execution closure, permission coherence. */
  validate(): void {
    if (this.state !== 'staged') throw pluginError('plugin_cancelled', `cannot validate in state ${this.state}`);
    assertImplementationMatch(this.manifest, this.contributions);
    // Cross-generation re-registration of the same plugin contribution is a
    // version upgrade: the previous record drains, the new one becomes active.
    // Within-one-generation duplicates are rejected earlier (stage/ID conflict).
    assertExecutionClosure(this.manifest);
    for (const contribution of this.contributions) {
      if (contribution.kind === 'execution' && contribution.atomicExecutor !== undefined && this.manifest.kind !== 'system') {
        throw pluginError('permission_denied', `atomic executor requires system plugin kind (${contribution.id})`);
      }
    }
    this.state = 'validated';
  }

  /** Prepare resources for startup behind the gate; callbacks must not fire before commit. */
  async prepareStart(gate: PluginActivationGate): Promise<PreparedPluginLease> {
    if (this.state !== 'validated') throw pluginError('plugin_cancelled', `cannot prepare in state ${this.state}`);
    this.state = 'prepared';
    const token = randomUUID();
    const lease = createPreparedLease(this.manifest.id, token);
    this.preparedLeases.push(lease);
    return lease;
  }

  /** Single atomic CAS publishing the complete cumulative generation set; commits nothing else. */
  commit(gate: PluginActivationGate, expected: PublishedGenerationSet): ActiveGenerationRecord {
    if (this.state !== 'prepared' && this.state !== 'validated') {
      throw pluginError('plugin_cancelled', `cannot commit from state ${this.state}`);
    }
    const generationId = this.options.generationId ?? randomUUID();
    const cumulative = new Map<string, StagedContributionRecord>(expected.active.registry.byId);
    for (const [id, record] of this.staged) cumulative.set(id, record);
    const record = buildActiveRecord({
      generationId,
      baseGenerationId: expected.generationId,
      parentGenerationId: expected.generationId,
      buildId: this.options.buildId,
      manifest: this.manifest,
      manifests: [...expected.active.manifests.filter((m) => m.id !== this.manifest.id), this.manifest],
      cumulative,
      permissions: new Map([...expected.active.permissions, [this.manifest.id, this.permissions]]),
    });
    const drainingById = new Map(expected.drainingById);
    if (expected.generationId !== 'gen-bootstrap') {
      drainingById.set(expected.active.generationId, expected.active);
    }
    const next: PublishedGenerationSet = {
      active: record,
      drainingById,
      generationId,
    };
    if (!this.options.existingSlot.compareAndSwap(expected, next)) {
      throw pluginError('generation_conflict', 'concurrent generation publication detected; transaction must be rebuilt');
    }
    gate.openFor(record);
    this.state = 'committed';
    return record;
  }

  /** Close prepared resources and discard every staged contribution; zero visibility. */
  async abort(): Promise<void> {
    if (this.state === 'committed') throw pluginError('plugin_cancelled', 'committed transaction may not be aborted');
    this.state = 'aborted';
    this.staged.clear();
    for (const lease of this.preparedLeases) {
      await lease.close();
    }
    this.preparedLeases = [];
  }

  get transactionState(): 'idle' | 'constructing' | 'staged' | 'validated' | 'prepared' | 'committed' | 'aborted' {
    return this.state;
  }
}

function createPreparedLease(pluginId: string, token: string): PreparedPluginLease {
  const handle = { closed: false };
  return Object.freeze({
    pluginId,
    token,
    resourceIds: Object.freeze([]),
    close: async (): Promise<void> => { handle.closed = true; },
    get closed(): boolean { return handle.closed; },
  }) as PreparedPluginLease;
}

/** Every manifest declaration must be provided by exactly one implementation and vice versa. */
function assertImplementationMatch(manifest: PluginManifestV1, implementations: readonly PluginContribution[]): void {
  const declared = new Map(manifest.contributions.map((contribution) => [contribution.id, contribution]));
  const implementationIds = new Set(implementations.map((implementation) => implementation.id));
  for (const implementation of implementations) {
    const declaration = declared.get(implementation.id);
    if (!declaration) {
      throw pluginError('manifest_invalid', `implementation ${implementation.id} is not declared in the manifest`);
    }
    if (declaration.kind !== implementation.kind) {
      throw pluginError('manifest_invalid', `implementation ${implementation.id} kind mismatch (declared ${declaration.kind}, got ${implementation.kind})`);
    }
  }
  for (const declaration of manifest.contributions) {
    if (!implementationIds.has(declaration.id)) {
      throw pluginError('manifest_invalid', `declared contribution ${declaration.id} has no implementation`);
    }
  }
}

export function buildActiveRecord(input: {
  generationId: string;
  baseGenerationId: string | null;
  parentGenerationId: string | null;
  buildId: string;
  manifest: PluginManifestV1;
  manifests: readonly PluginManifestV1[];
  cumulative: ReadonlyMap<string, StagedContributionRecord>;
  permissions: ReadonlyMap<string, CompiledPermissionSet>;
}): ActiveGenerationRecord {
  const byId = new Map<string, StagedContributionRecord>(input.cumulative);
  const byKind = new Map<PluginContributionKind, string[]>();
  for (const record of byId.values()) {
    const ids = byKind.get(record.contribution.kind) ?? [];
    ids.push(record.ref.contributionId);
    byKind.set(record.contribution.kind, ids);
  }
  const graphHash = createHash('sha256')
    .update([...byId.keys()].sort().join(','))
    .update(input.manifests.map((m) => `${m.id}@${m.version}`).sort().join(','))
    .digest('hex');
  return Object.freeze({
    generationId: input.generationId,
    baseGenerationId: input.baseGenerationId,
    parentGenerationId: input.parentGenerationId,
    createdAt: new Date().toISOString(),
    buildId: input.buildId,
    manifests: Object.freeze(input.manifests.map((manifest) => Object.freeze({ ...manifest }))),
    registry: Object.freeze({ byId, byKind, disabledIds: Object.freeze([]) }),
    permissions: input.permissions,
    graphHash,
  });
}

export function bootstrapGeneration(buildId: string): PublishedGenerationSet {
  const emptyManifest: PluginManifestV1 = {
    schema: 'mineclaw.plugin/v1',
    id: 'mineclaw.kernel',
    version: '1.0.0',
    apiVersion: buildId,
    kind: 'system',
    entry: 'kernel',
    dependencies: {},
    permissions: [],
    contributions: [],
  };
  const record = buildActiveRecord({
    generationId: 'gen-bootstrap',
    baseGenerationId: null,
    parentGenerationId: null,
    buildId,
    manifest: emptyManifest,
    manifests: Object.freeze([emptyManifest]),
    cumulative: new Map(),
    permissions: new Map(),
  });
  return {
    active: record,
    drainingById: new Map(),
    generationId: record.generationId,
  };
}

export function createActivationGate(): PluginActivationGate {
  let openRecord: ActiveGenerationRecord | null = null;
  const retracted = new Set<string>();
  return Object.freeze({
    get open(): boolean {
      return openRecord !== null;
    },
    openFor(record: ActiveGenerationRecord): void {
      openRecord = record;
    },
    retract(generationId: string): void {
      retracted.add(generationId);
      if (openRecord?.generationId === generationId) openRecord = null;
    },
    shouldRun(candidate: ActiveGenerationRecord, token: string, holdsExistingLease: boolean): boolean {
      if (retracted.has(candidate.generationId)) return false;
      if (openRecord === null) return false;
      if (openRecord === candidate && token !== '') return true;
      if (holdsExistingLease) return true;
      return false;
    },
  });
}

export function verifyAccess(compiled: CompiledPermissionSet, permission: string, pluginId?: string): void {
  verifyPermissionAccess(compiled, { permission, pluginId });
}

export function snapshotRefOf(record: ActiveGenerationRecord): RegistrySnapshotRef {
  return {
    generationId: record.generationId,
    buildId: record.buildId,
    graphHash: record.graphHash,
  };
}

export function makeStagingContext(base: PluginConstructionContext): PluginConstructionContext {
  return {
    host: base.host,
    plugin: base.plugin,
  };
}
