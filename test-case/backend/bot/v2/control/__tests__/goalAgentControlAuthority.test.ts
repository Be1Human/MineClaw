import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ContributionRef, RegistrySnapshotRef } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/identity.js';
import type {
  AuthorizedAcquisitionContext,
  GoalAgentControlState,
  StrategyControlGrant,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/control/contracts/controlState.js';
import { GoalAgentControlAuthority } from '../../../../../../apps/minecraft-companion/src/bot/v2/control/goalAgentControlAuthority.js';
import { ControlStateRepository } from '../../../../../../apps/minecraft-companion/src/bot/v2/control/persistence/controlStateRepository.js';

const companionId = 'companion-control-test';
const strategy: ContributionRef = {
  pluginId: 'mineclaw.owner-protection',
  pluginVersion: '1.0.0',
  contributionId: 'mineclaw.owner-protection.strategy',
  contributionVersion: '1.0.0',
};
const operation: ContributionRef = {
  pluginId: 'mineclaw.combat',
  pluginVersion: '1.0.0',
  contributionId: 'mineclaw.combat.atomic.attack',
  contributionVersion: '1.0.0',
};
const snapshot: RegistrySnapshotRef = {
  generationId: 'generation-1',
  buildId: 'build-1',
  graphHash: 'graph-1',
};

test('F01/U01/U32: a new companion starts fenced in durable reconcile, not in a guessed idle state', () => {
  const repository = new ControlStateRepository(':memory:');
  const authority = new GoalAgentControlAuthority(repository);
  const state = authority.initialize(companionId, 'reconcile-1', 100);

  assert.equal(state.controlRevision, 0);
  assert.equal(state.lastEventSequence, 0);
  assert.equal(state.state.kind, 'transferring');
  assert.equal(state.state.bodyAdmissionGate, 'fenced');
  if (state.state.kind === 'transferring') {
    assert.equal(state.state.phase, 'reconcile');
    assert.equal(state.state.bodyAdmissionEpoch, 0);
    assert.equal(state.state.targetBodyAdmissionEpoch, 1);
  }
  assert.deepEqual(authority.initialize(companionId, 'different-reconcile', 200), state);
  repository.close();
});

test('F01/U05/U09: Authority rejects commit before drain and opens epoch only in the stable commit', () => {
  const repository = new ControlStateRepository(':memory:');
  const authority = new GoalAgentControlAuthority(repository);
  authority.initialize(companionId, 'reconcile-1', 100);

  const acquisition = strategyAcquisition(1);
  const grant = strategyGrant(acquisition);
  const delegated = delegatedState(grant, 1, 130);
  const premature = authority.commitDelegation(command(0, 'commit', 'commit:strategy', 'digest-a'), delegated, grant, acquisition);
  assert.equal(premature.kind, 'rejected');
  if (premature.kind === 'rejected') {
    assert.equal(premature.reason, 'invalid_transition');
    assert.equal(premature.eventSequence, 1);
  }

  const draining = authority.advanceTransfer(command(0, 'drain', 'phase:drain', 'digest-b'), 'initial-reconcile:companion-control-test', 'drain');
  assert.equal(draining.kind, 'committed');
  const drained = authority.advanceTransfer(command(1, 'drain', 'phase:drain_quiesced', 'digest-c'), 'initial-reconcile:companion-control-test', 'drain_quiesced');
  assert.equal(drained.kind, 'committed');
  const idle = authority.settleIdle(command(2, 'commit', 'settle:idle', 'digest-d'), {
    kind: 'idle', controlRevision: 0, bodyAdmissionEpoch: 1, bodyAdmissionGate: 'open', updatedAt: 125,
  });
  assert.equal(idle.kind, 'committed');
  const admitted = authority.admitTransfer(command(3, 'fence', 'transfer:strategy', 'digest-e'), {
    transferId: 'transfer-strategy-1',
    to: acquisition.target,
    initiatedBy: acquisition.authorizedBy,
    targetAcquisition: acquisition,
  });
  assert.equal(admitted.kind, 'committed');
  assert.equal(authority.advanceTransfer(command(4, 'drain', 'strategy:drain', 'digest-f'), 'transfer-strategy-1', 'drain').kind, 'committed');
  assert.equal(authority.advanceTransfer(command(5, 'drain', 'strategy:drain-quiesced', 'digest-g'), 'transfer-strategy-1', 'drain_quiesced').kind, 'committed');
  const committed = authority.commitDelegation(command(6, 'commit', 'commit:strategy:ready', 'digest-h'), delegated, grant, acquisition);
  assert.equal(committed.kind, 'committed');
  if (committed.kind === 'committed') {
    assert.equal(committed.controlRevision, 7);
    assert.equal(committed.eventSequence, 8);
    assert.equal(committed.value.kind, 'delegated');
    assert.equal(committed.value.bodyAdmissionEpoch, 1);
    assert.equal(committed.value.bodyAdmissionGate, 'open');
  }
  repository.close();
});

test('F01/U29/U30: command step replay is idempotent while digest conflict and stale CAS are audited', () => {
  const repository = new ControlStateRepository(':memory:');
  const authority = new GoalAgentControlAuthority(repository);
  authority.initialize(companionId, 'reconcile-1', 100);

  const firstCommand = command(0, 'drain', 'phase:drain', 'same-step');
  const first = authority.advanceTransfer(firstCommand, 'initial-reconcile:companion-control-test', 'drain');
  assert.equal(first.kind, 'committed');
  const replay = authority.advanceTransfer(firstCommand, 'initial-reconcile:companion-control-test', 'drain');
  assert.equal(replay.kind, 'idempotent_replay');
  if (replay.kind === 'idempotent_replay') {
    assert.equal(replay.controlRevision, 1);
    assert.equal(replay.eventSequence, 1);
  }

  const conflict = authority.advanceTransfer(
    { ...firstCommand, expectedControlRevision: 1, stepDigest: 'changed-step-digest' },
    'initial-reconcile:companion-control-test',
    'drain_quiesced',
  );
  assert.equal(conflict.kind, 'rejected');
  if (conflict.kind === 'rejected') {
    assert.equal(conflict.reason, 'conflict');
    assert.equal(conflict.currentControlRevision, 1);
    assert.equal(conflict.eventSequence, 2);
  }

  const stale = authority.recordAudit(command(0, 'audit', 'audit:stale', 'stale-step'), 'control.test', {});
  assert.equal(stale.kind, 'rejected');
  if (stale.kind === 'rejected') {
    assert.equal(stale.reason, 'stale');
    assert.equal(stale.currentControlRevision, 1);
    assert.equal(stale.eventSequence, 3);
  }
  assert.equal(repository.listEvents(companionId).length, 3);
  assert.equal(authority.inspect(companionId)?.lastEventSequence, 3);
  repository.close();
});

test('F01/U31/I01: snapshot and event stream remain coherent across two connections to the GoalAgent database', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-agent-control-'));
  const filename = join(root, 'goal-agent-profile.db');
  try {
    const firstRepository = new ControlStateRepository(filename);
    const secondRepository = new ControlStateRepository(filename);
    const first = new GoalAgentControlAuthority(firstRepository);
    const second = new GoalAgentControlAuthority(secondRepository);
    first.initialize(companionId, 'reconcile-1', 100);

    assert.equal(first.advanceTransfer(command(0, 'drain', 'phase:drain', 'cross-connection'), 'initial-reconcile:companion-control-test', 'drain').kind, 'committed');
    const observed = second.inspect(companionId);
    assert.equal(observed?.controlRevision, 1);
    assert.equal(observed?.lastEventSequence, 1);
    assert.equal(second.advanceTransfer(command(0, 'drain', 'phase:stale', 'cross-stale'), 'initial-reconcile:companion-control-test', 'drain_quiesced').kind, 'rejected');
    assert.equal(first.inspect(companionId)?.lastEventSequence, 2);

    firstRepository.close();
    secondRepository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F01/U30: storage failure never fabricates a durable quarantine or success result', () => {
  const repository = new ControlStateRepository(':memory:');
  const authority = new GoalAgentControlAuthority(repository);
  authority.initialize(companionId, 'reconcile-1', 100);
  repository.close();

  const result = authority.recordAudit(command(0, 'audit', 'audit:closed-db', 'closed-db'), 'control.test', {});
  assert.equal(result.kind, 'storage_unavailable');
  if (result.kind === 'storage_unavailable') {
    assert.deepEqual(result.protection, {
      failClosedGateEstablished: false,
      hostIsolationEstablished: false,
      bodyDisconnectRequired: true,
    });
  }
});

function command(expectedControlRevision: number, stage: string, stepId: string, stepDigest: string) {
  return {
    companionId,
    expectedControlRevision,
    commandId: 'command-1',
    rootCommandDigest: 'root-command-digest',
    stepId,
    stepDigest,
    stage,
    workId: 'initial-reconcile:companion-control-test',
    occurredAt: 120 + expectedControlRevision,
  };
}

function strategyAcquisition(bodyAdmissionEpoch: number): AuthorizedAcquisitionContext {
  return {
    acquisitionContextId: 'acquisition-1',
    contextRevision: 1,
    contextDigest: 'acquisition-digest',
    target: { kind: 'strategy_activation', strategy, reservedStrategySessionId: 'strategy-session-1' },
    snapshot,
    authorizedBy: { kind: 'owner', admissionId: 'owner-admission-1', ownerRevision: 1 },
    scope: { companionId, policyScope: null, incidentId: null, resourceIds: ['body'] },
    allowedOperations: [operation],
    allowedResources: ['body'],
    priorityCeiling: 100,
    deadlineAt: null,
    normalizedConfigDigest: 'config-digest',
    expectedPhysicalOwnerKind: 'task',
    targetBodyAdmissionEpoch: bodyAdmissionEpoch,
    sourceEventSequence: 2,
    createdAt: 120,
  };
}

function strategyGrant(acquisition: AuthorizedAcquisitionContext): StrategyControlGrant {
  const subject = { kind: 'strategy' as const, strategyId: strategy.contributionId, strategySessionId: 'strategy-session-1' };
  return {
    kind: 'strategy',
    grantId: 'strategy-grant-1',
    grantEpoch: 1,
    subject,
    snapshot,
    scope: acquisition.scope,
    allowedOperations: acquisition.allowedOperations,
    allowedResources: acquisition.allowedResources,
    priorityCeiling: acquisition.priorityCeiling,
    issuedAt: 130,
    deadlineAt: null,
    authorizedBy: acquisition.authorizedBy,
    acquisition,
    physicalOwnerNamespace: {
      namespaceId: 'namespace-1',
      subject,
      acquisition,
      ownerKind: 'task',
      namespaceEpoch: 1,
      bodyAdmissionEpoch: acquisition.targetBodyAdmissionEpoch,
    },
    bodyAdmissionEpoch: acquisition.targetBodyAdmissionEpoch,
    policyGrantId: null,
  };
}

function delegatedState(
  grant: StrategyControlGrant,
  bodyAdmissionEpoch: number,
  updatedAt: number,
): Extract<GoalAgentControlState, { kind: 'delegated' }> {
  return {
    kind: 'delegated',
    controlRevision: 0,
    subject: grant.subject,
    grantId: grant.grantId,
    grantEpoch: grant.grantEpoch,
    policyGrantId: grant.policyGrantId,
    authorizedBy: grant.authorizedBy,
    acquisition: grant.acquisition,
    bodyAdmissionEpoch,
    bodyAdmissionGate: 'open',
    suspendedGoal: null,
    updatedAt,
  };
}
