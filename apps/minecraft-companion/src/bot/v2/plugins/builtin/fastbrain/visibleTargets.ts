import type { GameAdapter } from '../../../../adapter/GameAdapter.js';
import { SwitchableGameAdapter } from '../../../../adapter/SwitchableGameAdapter.js';
import type { Vec3 } from '../../../../adapter/types.js';
import type { DecisionContext, DecisionHandler } from './adapter.js';

/** A host-issued reference, never a coordinate or visibility assertion from a policy. */
export interface VisibleTarget {
  readonly targetId: string;
  readonly kind: 'block';
  readonly name: string;
  readonly stateId: number;
  readonly canDig: boolean | null;
  readonly position: Vec3;
  readonly observationVersion: string;
  readonly observedAt: number;
  readonly sessionId: string;
  readonly actor: string;
  readonly dimension: string;
  readonly evidenceRefs: readonly string[];
}

export interface VisibleTargetSearch {
  readonly status: 'partial' | 'blocked' | 'cancelled' | 'timeout' | 'error';
  readonly reason: string;
  readonly observationVersion?: string;
  readonly observedAt?: number;
  readonly targets: readonly VisibleTarget[];
  readonly requestedBounds: Readonly<{ radius: number; origin?: Vec3 }>;
  /** These points are observed; the surrounding volume is NOT proved searched. */
  readonly observedBounds: Readonly<{ kind: 'visible_target_points'; positions: readonly Vec3[] }>;
  readonly complete: false;
  readonly truncated: boolean;
  readonly evidenceRefs: readonly string[];
}

export type VisibleTargetResolution =
  | { readonly status: 'resolved'; readonly target: VisibleTarget; readonly validatedAt: number }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Consumer-owned, read-only contract; it grants no GameActions or navigation. */
export interface VisibleTargetReader {
  search(kind: string, radius: number, context: DecisionContext): VisibleTargetSearch;
  resolve(targetId: string, context: DecisionContext): VisibleTargetResolution;
  close(): void;
}

export interface FastBrainVisibleTargets extends VisibleTargetReader {}

/**
 * Resolve only the existing switchable adapter boundary. A new concrete body
 * gets a new reader; a reference can never migrate to the replacement body.
 */
export function createFastBrainVisibleTargets(game: GameAdapter): FastBrainVisibleTargets {
  let current: GameAdapter | null = null;
  let reader: VisibleTargetReader | null = null;
  let closed = false;
  const source = (): VisibleTargetReader | null => {
    if (closed) return null;
    let concrete = game;
    const visited = new Set<GameAdapter>();
    while (concrete instanceof SwitchableGameAdapter) {
      if (visited.has(concrete)) return null;
      visited.add(concrete);
      concrete = concrete.getTarget();
    }
    if (concrete !== current) {
      reader?.close();
      current = concrete;
      const factory = (concrete as GameAdapter & {
        createVisibleTargetReader?: () => VisibleTargetReader;
      }).createVisibleTargetReader;
      reader = typeof factory === 'function' ? factory.call(concrete) : null;
    }
    return reader;
  };
  return {
    search(kind, radius, context) {
      return source()?.search(kind, radius, context)
        ?? unavailableSearch(radius, closed ? 'visible_targets_closed' : 'visible_targets_contract_unavailable');
    },
    resolve(targetId, context) {
      return source()?.resolve(targetId, context)
        ?? { status: 'unavailable', reason: closed ? 'visible_targets_closed' : 'visible_targets_contract_unavailable' };
    },
    close() { closed = true; reader?.close(); reader = null; current = null; },
  };
}

export function createFastBrainVisibleTargetHandlers(service: FastBrainVisibleTargets): ReadonlyMap<string, DecisionHandler> {
  return new Map([['search', {
    available: true,
    run: async (decision, context) => {
      if (decision.type !== 'call' || decision.skill !== 'search') throw new Error('search_decision_required');
      const result = service.search(String(decision.args.kind), Number(decision.args.radius), context);
      return { status: result.status, reason: result.reason, effectKnowledge: 'confirmed',
        evidenceRefs: result.evidenceRefs, details: { ...result } };
    },
  }]]);
}

export function unavailableSearch(radius: number, reason: string, status: VisibleTargetSearch['status'] = 'blocked'): VisibleTargetSearch {
  return { status, reason, targets: [], requestedBounds: { radius },
    observedBounds: { kind: 'visible_target_points', positions: [] },
    complete: false, truncated: false, evidenceRefs: [] };
}
