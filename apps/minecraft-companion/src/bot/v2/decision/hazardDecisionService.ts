/**
 * Hazard routing is a pure decision boundary.
 *
 * It deliberately does not own a task, pause a task, issue a grant, or submit a
 * body operation.  The heartbeat consumes this result to decide whether the
 * generic fallback strategy is allowed to run for the current observation.
 */

import type { WorldStateView } from '../types.js';

export type HazardCategory = 'hostile';

export type HazardDecision =
  | { kind: 'none'; category: HazardCategory }
  | { kind: 'managed'; category: HazardCategory }
  | { kind: 'fallback'; category: HazardCategory };

export interface HazardHandlingQuery {
  (category: HazardCategory): boolean;
}

export class HazardDecisionService {
  decide(
    world: Pick<WorldStateView, 'entities'>,
    isHazardManaged: HazardHandlingQuery,
  ): HazardDecision {
    const category: HazardCategory = 'hostile';
    // A declared Activity owns the whole hazard lifecycle, including the calm
    // recovery window after a hostile leaves perception. Do not re-enable the
    // generic fallback merely because this one snapshot has no hostile entity.
    if (isHazardManaged(category)) {
      return { kind: 'managed', category };
    }
    if (!world.entities.some(entity => entity.category === category)) {
      return { kind: 'none', category };
    }
    return { kind: 'fallback', category };
  }
}
