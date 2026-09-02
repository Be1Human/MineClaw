/**
 * Execution closure validation (kernel design §5.7/§5.12).
 * A declared operation is `available` only when the full chain
 * Goal → Binding → Fact → Candidate → Operation → Executor → Predicate →
 * Progress → Result resolves inside the package or its declared dependencies.
 * This is a structural contract check inside the SDK; the registration
 * transaction additionally resolves versions and runtime permissions.
 */
import { pluginError, type PluginFailureCode } from './errors.js';
import type { PluginManifestV1 } from './manifest.js';
import type { ContributionRequirement } from './dependencies.js';
import type { ExecutionContribution, ManifestContribution } from './contributions.js';

export interface ClosureVerification {
  readonly closed: boolean;
  readonly missing: readonly string[];
}

const REQUIRED_RING = [
  'goal',
  'binding',
  'fact',
  'candidate',
  'operation',
  'executor',
  'predicate',
  'progress',
  'result',
] as const;

export type ClosureRing = (typeof REQUIRED_RING)[number];

export function verifyExecutionClosure(manifest: PluginManifestV1): ClosureVerification {
  const missing: string[] = [];
  for (const contribution of manifest.contributions) {
    if (contribution.kind !== 'execution') continue;
    const operation = (contribution as { operation?: ManifestContribution & { kind: 'execution' } extends never ? never : ExecutionContribution['operation'] }).operation;
    if (!operation) continue; // system atomic catalog: primitive supply, no closure requirement
    const owner = contribution as unknown as ExecutionContribution;
    for (const ring of REQUIRED_RING) {
      if (!ringIsResolved(ring, operation, owner, manifest)) missing.push(`${operation.operationId}:${ring}`);
    }
  }
  return { closed: missing.length === 0, missing: Object.freeze(missing) };
}

/** Throws `package_incomplete` with the list of unresolved rings. */
export function assertExecutionClosure(manifest: PluginManifestV1): void {
  const verification = verifyExecutionClosure(manifest);
  if (!verification.closed) {
    throw pluginError('package_incomplete', `execution closure incomplete: ${verification.missing.join(', ')}`, {
      missing: verification.missing,
    });
  }
}

function ringIsResolved(
  ring: ClosureRing,
  operation: NonNullable<ExecutionContribution['operation']>,
  owner: ExecutionContribution,
  manifest: PluginManifestV1,
): boolean {
  const available = new Set<string>(manifest.contributions.map((contribution) => contribution.id));
  const requirements = collectRequirements(manifest);
  const canUse = (id: string): boolean => available.has(id) || requirements.has(id);
  switch (ring) {
    case 'goal': return canUse(operation.goalContributionId);
    case 'binding': return canUse(operation.bindingContributionId);
    case 'fact': return operation.factKinds.length > 0;
    case 'candidate': return canUse(operation.candidateContributionId);
    case 'operation': return operation.operationId.trim().length > 0;
    case 'executor': return owner.id.trim().length > 0;
    case 'predicate': return canUse(operation.predicateContributionId);
    case 'progress': return canUse(operation.progressContributionId);
    case 'result': return canUse(operation.resultContributionId);
  }
}

/** The executor ring is satisfied when the execution declaration exists; construct-time implementation matching is enforced by the transaction. */
function contributionHasExecutor(_owner: ExecutionContribution): boolean {
  return true;
}

function collectRequirements(manifest: PluginManifestV1): Set<string> {
  const result = new Set<string>();
  for (const contribution of manifest.contributions) {
    const requirements = (contribution as { requirements?: readonly ContributionRequirement[] }).requirements;
    for (const requirement of requirements ?? []) result.add(requirement.contributionId);
  }
  return result;
}

export function packageIncompleteError(missing: readonly string[]): { code: PluginFailureCode; message: string } {
  return { code: 'package_incomplete', message: `execution closure incomplete: ${missing.join(', ')}` };
}
