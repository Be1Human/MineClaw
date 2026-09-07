import { randomUUID } from 'node:crypto';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { tuning } from '../../infra/tuning.js';
import type { ExecutionOwner, OperationIdentity, OperationIntent, OperationSnapshot } from '../contracts/bodyOperation.js';
import type { AuthorizedOperation, BodyExecutionPort, ExecutionAuthorityPort, ExecutionClock, OperationHandle, OwnerStopResult } from './ports/bodyExecution.js';
import type { BodyOperationDriver } from './ports/controlledExecution.js';
import { OperationLifetime } from './operationLifetime.js';
import { operationArgsHash, type OperationLedgerPort, type OperationLedgerRecord } from './operationLedger.js';
import type { OperationReceipt } from '../contracts/operationReceipt.js';

export class BodyAdmissionError extends Error {
  constructor(readonly code: string, readonly conflicts: readonly string[] = []) {
    super(code);
    this.name = 'BodyAdmissionError';
  }
}

interface Entry {
  readonly intentJson: string;
  readonly intent: OperationIntent;
  readonly lifetime: OperationLifetime;
}

const systemClock: ExecutionClock = {
  now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** The sole resource owner. Driver code and policies cannot create/release leases. */
export class BodyExecutionRuntime implements BodyExecutionPort {
  private readonly entries = new Map<string, Entry>();
  private readonly resources = new Map<string, OperationIdentity>();
  private readonly closedOwners = new Set<string>();
  private operationEpoch = 0;
  private readonly instanceId = randomUUID();
  private readonly clock: ExecutionClock;

  constructor(private readonly options: {
    driver: BodyOperationDriver;
    authority: ExecutionAuthorityPort;
    ledger: OperationLedgerPort;
    clock?: ExecutionClock;
  }) {
    if (!options.driver || typeof options.driver.resources !== 'function' || typeof options.driver.bind !== 'function'
      || !options.authority || typeof options.authority.allows !== 'function' || typeof options.authority.grantHash !== 'function'
      || !options.ledger || typeof options.ledger.begin !== 'function') throw new Error('body_execution_ports_required');
    this.clock = options.clock ?? systemClock;
  }

  submit(input: AuthorizedOperation): OperationHandle {
    const intent = jsonSnapshot(input.intent);
    validateIntent(intent);
    const intentJson = JSON.stringify(intent);
    const existing = this.entries.get(intent.operationId);
    // A previously accepted identity is immutable; terminal evidence is safe to replay.
    if (existing) {
      if (existing.intentJson !== intentJson) throw new BodyAdmissionError('operation_identity_conflict');
      if (!this.allowed({ intent, grant: input.grant }, intent.command)) throw new BodyAdmissionError('operation_not_authorized');
      return existing.lifetime.handle;
    }
    const operation = Object.freeze({ intent, grant: input.grant });
    if (this.closedOwners.has(ownerKey(intent.owner)) || !this.allowed(operation, intent.command)) throw new BodyAdmissionError('operation_not_authorized');
    const maximum = tuning().controlledExecution.operationTimeoutMs;
    if (!Number.isFinite(maximum) || maximum <= 0) throw new BodyAdmissionError('invalid_operation_timeout');
    if (intent.deadlineAt <= this.clock.now()) throw new BodyAdmissionError('deadline_exceeded');
    const declared = this.options.driver.resources(intent.command);
    if (!Array.isArray(declared) || declared.some(resource => typeof resource !== 'string' || !resource.trim())) throw new BodyAdmissionError('invalid_resource_declaration');
    const claims = [...new Set(declared)].sort();
    const conflicts = [...new Set(claims.flatMap(resource => this.resources.get(resource)?.operationId ?? []))];
    if (conflicts.length) {
      if (intent.preemption === 'request') for (const id of conflicts) {
        const previous = this.entries.get(id)!;
        if (intent.priority > previous.intent.priority) previous.lifetime.cancel(`preempted_by:${intent.operationId}`);
      }
      throw new BodyAdmissionError('body_resources_busy', conflicts);
    }
    const operationEpoch = ++this.operationEpoch;
    const identity: OperationIdentity = jsonSnapshot({ operationId: intent.operationId, owner: intent.owner, operationEpoch,
      leaseRef: `${this.instanceId}:${operationEpoch}`, deadlineAt: Math.min(intent.deadlineAt, this.clock.now() + maximum) });
    const grantHash = this.options.authority.grantHash(operation);
    if (!grantHash) throw new BodyAdmissionError('operation_not_authorized');
    const source = jsonSnapshot({ commandId:intent.command.ref.id,contribution:intent.command.ref.contribution,
      snapshot:intent.command.snapshot,argsHash:operationArgsHash(intent.command.args),grantHash });
    const ledger = this.options.ledger.begin({ intent, identity, grantHash, startedAt: this.clock.now() });
    if (ledger.status === 'completed') return replayHandle(ledger.receipt);
    if (ledger.status === 'in_doubt') return inDoubtHandle(ledger.record, this.clock.now());
    const lifetime = new OperationLifetime({ identity, operation, source, resources: claims, driver: this.options.driver, clock: this.clock,
      isCurrent: command => !this.closedOwners.has(ownerKey(intent.owner)) && this.allowed(operation, command)
        && claims.every(resource => this.resources.get(resource)?.leaseRef === identity.leaseRef),
      onQuiesced: () => {
        // Late completion cannot release a newer generation's resources.
        for (const resource of claims) if (this.resources.get(resource)?.leaseRef === identity.leaseRef) this.resources.delete(resource);
      },
      onCancelRequested: (reason, at) => this.options.ledger.requestCancel(intent.operationId, reason, at),
      onEffect: (effect, at) => this.options.ledger.recordEffect(intent.operationId, effect, at),
      onStop: stop => this.options.ledger.acknowledgeStop(intent.operationId, stop),
      onTerminal: receipt => this.options.ledger.complete(receipt),
      onInDoubt: (reason, at) => this.options.ledger.markInDoubt(intent.operationId, reason, at),
    });
    for (const resource of claims) this.resources.set(resource, identity);
    this.entries.set(intent.operationId, { intentJson, intent, lifetime });
    lifetime.start();
    return lifetime.handle;
  }

  inspect(operationId: string): OperationSnapshot | null {
    const live = this.entries.get(operationId)?.lifetime.snapshot();
    if (live) return live;
    const persisted = this.options.ledger.get(operationId);
    if (!persisted?.identity) return null;
    return jsonSnapshot({ ...persisted.identity,
      state: persisted.receipt ? 'settled' : 'quarantined', resources: [], actionsStarted: persisted.effects.length,
      pendingWork: 0, cancelReason: persisted.status === 'cancel_requested' ? persisted.recoveryReason : null,
      stopErrors: persisted.status === 'in_doubt' && persisted.recoveryReason ? [persisted.recoveryReason] : [], stop: persisted.stop });
  }

  active(): readonly OperationSnapshot[] {
    return [...this.entries.values()].map(entry => entry.lifetime.snapshot()).filter(snapshot => snapshot.state !== 'settled');
  }

  async cancelOwner(owner: ExecutionOwner, reason: string): Promise<OwnerStopResult> {
    const key = ownerKey(owner);
    this.closedOwners.add(key);
    const matching = [...this.entries.values()].filter(entry => ownerKey(entry.intent.owner) === key);
    for (const entry of matching) entry.lifetime.cancel(reason);
    await Promise.all(matching.map(entry => entry.lifetime.handle.result));
    const operations = matching.map(entry => entry.lifetime.snapshot());
    return jsonSnapshot({ owner, status: operations.every(snapshot => snapshot.stop !== null) ? 'quiesced' : 'in_doubt', operations });
  }

  private allowed(operation: AuthorizedOperation, command: OperationIntent['command']): boolean {
    try { return this.options.authority.allows(operation, command) === true; } catch { return false; }
  }
}

function replayHandle(receipt: OperationReceipt): OperationHandle {
  return Object.freeze({
    operationId: receipt.operationId,
    result: Promise.resolve(jsonSnapshot(receipt)),
    cancel: () => undefined,
    quiesced: () => receipt.stop ? Promise.resolve(jsonSnapshot(receipt.stop)) : Promise.reject(new Error('operation_stop_unconfirmed')),
  });
}

function inDoubtHandle(record: OperationLedgerRecord, completedAt: number): OperationHandle {
  const identity = record.identity;
  if (!identity) throw new BodyAdmissionError('needs_rebind:operation_source_unproven');
  const evidenceRefs = [...new Set(record.effects.flatMap(effect => effect.evidenceRefs))];
  const intent = record.intent;
  if (!intent || !record.argsHash || !record.grantHash) throw new BodyAdmissionError('needs_rebind:operation_source_unproven');
  const receipt: OperationReceipt = jsonSnapshot({
    ...identity, schema: 'mineclaw.operation-receipt/v2', source:{commandId:intent.command.ref.id,
      contribution:intent.command.ref.contribution,snapshot:intent.command.snapshot,argsHash:record.argsHash,grantHash:record.grantHash},
    status: 'in_doubt', stop: record.stop,
    noOp: record.effects.length === 0, effects: record.effects, evidenceRefs,
    failure: {
      code: 'execution.result_unknown', origin: 'infra', stage: 'executing', category: 'transient',
      retryable: false, ownerActionable: false, evidenceRefs,
      detail: record.recoveryReason ?? 'operation outcome requires world read-back reconciliation',
    },
    startedAt: record.startedAt, completedAt,
  });
  return Object.freeze({
    operationId: record.operationId, result: Promise.resolve(receipt), cancel: () => undefined,
    quiesced: () => record.stop ? Promise.resolve(jsonSnapshot(record.stop)) : Promise.reject(new Error('operation_in_doubt')),
  });
}

function ownerKey(owner: ExecutionOwner): string { return JSON.stringify(jsonSnapshot(owner)); }

function validateIntent(intent: OperationIntent): void {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const natural = (value: unknown, minimum = 1) => Number.isSafeInteger(value) && Number(value) >= minimum;
  const owner = intent?.owner;
  const ownerValid = owner && (owner.kind === 'goal' ? text(owner.taskId) && text(owner.sessionId) && natural(owner.epoch) && natural(owner.planRevision, 0)
    : owner.kind === 'task' && text(owner.taskId) && natural(owner.ownerEpoch));
  if (!text(intent?.operationId) || !ownerValid || !text(intent.command?.ref?.id)
    || !intent.command?.ref?.contribution || !text(intent.command.ref.contribution.pluginId)
    || !text(intent.command.ref.contribution.pluginVersion) || !text(intent.command.ref.contribution.contributionId)
    || !text(intent.command.ref.contribution.contributionVersion) || !intent.command.snapshot
    || !text(intent.command.snapshot.generationId) || !text(intent.command.snapshot.buildId) || !text(intent.command.snapshot.graphHash)
    || !intent.command.args || Array.isArray(intent.command.args) || typeof intent.command.args !== 'object'
    || !Array.isArray(intent.expectedEffects)
    || !Number.isFinite(intent.deadlineAt) || !natural(intent.budget?.maxActions) || !Number.isFinite(intent.priority)
    || !['none', 'request'].includes(intent.preemption) || !text(intent.scope?.dimension)
    || !Array.isArray(intent.scope.targetRefs) || !Array.isArray(intent.scope.bindings)) throw new BodyAdmissionError('invalid_operation_intent');
}
