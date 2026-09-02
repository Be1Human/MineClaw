import type { FactRegion } from './worldFact.js';

export interface PredicateRef {
  readonly id: string;
  readonly version: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface GoalDraft {
  readonly schema: 'mineclaw.goal-draft/v1';
  readonly requestRef: string;
  readonly success: { readonly allOf: readonly PredicateRef[] };
  readonly scope: {
    readonly dimension: string;
    readonly targetRefs: readonly string[];
    readonly allowedMutationRegion?: FactRegion;
  };
}

/** Code-owned interpretation of an observed, authorized target, never supplied by the model. */
export interface GoalScopeBinding {
  readonly id: string;
  readonly version: string;
  readonly kind: 'item' | 'entity' | 'region' | 'container' | 'self';
  readonly summary: string;
  readonly dimension: string;
  readonly registryId?: string;
  readonly position?: { readonly x: number; readonly y: number; readonly z: number };
  readonly region?: FactRegion;
  readonly mutationAllowed: boolean;
  /** Resource use is separate from permission to modify world blocks. */
  readonly allowedAccess?: ReadonlyArray<'observe' | 'use' | 'modify'>;
  readonly required: boolean;
  readonly requiredPredicates: readonly PredicateRef[];
  readonly evidenceRefs: readonly string[];
}

export type BoundGoalScope = GoalDraft['scope'] & {
  readonly bindings: readonly GoalScopeBinding[];
};

export const GOAL_DRAFT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object', additionalProperties: false, required: ['schema', 'requestRef', 'success', 'scope'],
  properties: {
    schema: { type: 'string', const: 'mineclaw.goal-draft/v1' }, requestRef: { type: 'string', minLength: 1 },
    success: { type: 'object', additionalProperties: false, required: ['allOf'], properties: {
      allOf: { type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false, required: ['id', 'version', 'args'],
        properties: { id: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 }, args: { type: 'object' } },
      } },
    } },
    scope: { type: 'object', additionalProperties: false, required: ['dimension', 'targetRefs'], properties: {
      dimension: { type: 'string', minLength: 1 }, targetRefs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      allowedMutationRegion: { type: 'object', additionalProperties: false, required: ['min', 'max'], properties: {
        min: positionSchema(), max: positionSchema(),
      } },
    } },
  },
};

function positionSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'],
    properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } };
}
