import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertSchemaSupported, shapeSchema, validateClosedArguments } from '../../infra/closedJsonSchema.js';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalAgentActionCandidate } from './ports/executionPort.js';
import { stableJson, isRecord } from './goalAgentJson.js';

/** Stateless grants: restart, plan changes and successful dispatch require a fresh listing. */
export class GoalAgentCandidateAuthority {
  private readonly secret = randomBytes(32);

  issue(candidate: GoalAgentActionCandidate, state: Readonly<GoalAgentStateV1>, catalogVersion: string): string {
    const identity = Buffer.from(candidate.id).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(stableJson({
      sessionId: state.sessionId, epoch: state.epoch, planRevision: state.plan.revision,
      node: state.plan.activeNodeId, root: state.rootGoal, actions: state.budget.actions,
      catalogVersion, candidate: candidateBinding(candidate),
    })).digest('base64url');
    return `candidate:${identity}.${signature}`;
  }

  candidateId(handle: string): string | null {
    const match = /^candidate:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(handle);
    return match ? Buffer.from(match[1]!, 'base64url').toString() : null;
  }

  matches(handle: string, candidate: GoalAgentActionCandidate, state: Readonly<GoalAgentStateV1>, version: string): boolean {
    const expected = Buffer.from(this.issue(candidate, state, version));
    const actual = Buffer.from(handle);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

/** Exclude labels/evidence timestamps, not executable identity, scope or availability. */
export function candidateBinding(candidate: GoalAgentActionCandidate): Record<string, unknown> {
  return {
    id: candidate.id, kind: candidate.kind, source: candidate.source, action: candidate.action,
    fixedArgs: candidate.fixedArgs, argumentSchema: candidate.argumentSchema ?? null,
    mutableArgumentPaths: [...(candidate.mutableArgumentPaths ?? [])].sort(),
    authorization: candidate.authorization ?? { status: 'ready', reasons: [] },
    operationRef: candidate.operationRef ?? null,
  };
}

const IDENTITY_FIELDS = new Set([
  'behavior', 'taskKind', 'strategyId', 'source', 'action', 'executor', 'executorRef',
  'operationId', 'operationRef', 'version', 'operationVersion', 'catalogVersion', 'packageId',
  'sessionId', 'epoch', 'planRevision', 'scope', 'resourceScope', 'authorization',
]);

function assertIdentityUnchanged(patch: unknown, fixed: unknown, path = ''): void {
  if (Array.isArray(patch)) patch.forEach((value, index) => assertIdentityUnchanged(value, Array.isArray(fixed) ? fixed[index] : undefined, `${path}/${index}`));
  else if (isRecord(patch)) for (const [key, value] of Object.entries(patch)) {
    const previous = isRecord(fixed) ? fixed[key] : undefined;
    if (IDENTITY_FIELDS.has(key) && !isDeepStrictEqual(value, previous)) throw new Error(`action_identity_locked:${path}/${key}`);
    assertIdentityUnchanged(value, previous, `${path}/${key}`);
  }
}

/** A narrow, closed schema is the whitelist; fixed non-business fields stay immutable. */
export function prepareCandidateArguments(candidate: GoalAgentActionCandidate, input: unknown): Record<string, unknown> {
  if (candidate.authorization && candidate.authorization.status !== 'ready') {
    throw new Error(`action_not_authorized:${candidate.authorization.reasons.join(',') || candidate.authorization.status}`);
  }
  const patch = input === undefined ? {} : jsonSnapshot(input);
  if (!isRecord(patch)) throw new Error('action_arguments_must_be_object');
  const fixed = jsonSnapshot(candidate.fixedArgs);
  assertIdentityUnchanged(patch, fixed);
  const schema = candidate.argumentSchema ?? shapeSchema(fixed);
  assertSchemaSupported(schema);
  const allowed = new Set(candidate.mutableArgumentPaths ?? []);
  const merge = (base: Record<string, unknown>, changes: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(changes)) {
      const path = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (isDeepStrictEqual(value, base[key])) continue;
      if (IDENTITY_FIELDS.has(key)) throw new Error(`action_identity_locked:${path}`);
      if (isRecord(value)) {
        result[key] = merge(isRecord(base[key]) ? base[key] : {}, value, path);
      } else {
        if (!allowed.has(path)) throw new Error(`action_argument_locked:${path}`);
        result[key] = structuredClone(value);
      }
    }
    return result;
  };
  const merged = merge(fixed, patch, '');
  validateClosedArguments(merged, schema, fixed);
  return merged;
}
