/**
 * Retired event reflex boundary.
 *
 * Earlier versions turned `under_attack` into an independent emergency task and
 * submitted behavior ids outside the pinned plugin generation. That created a
 * second control plane which could pause a running Activity before it acted.
 *
 * Hazard routing now happens in `HazardDecisionService`; registered Activities
 * own their declared hazard loop and the generic Survival fallback runs only
 * through the current task. This inert export is kept briefly for source-level
 * compatibility with integrations importing the historical class.
 */

import type { ActionRequest, BusEvent } from '../types.js';
import type { IEventDrivenStrategy, StrategyContext, StrategyInspect } from './types.js';

export class ReflexStrategy implements IEventDrivenStrategy {
  readonly id = 'reflex_strategy';
  readonly kind = 'reflex' as const;

  // Accept historical constructor arguments without retaining a task/runtime dependency.
  constructor(..._legacy: unknown[]) {}

  ingestCritical(_events: readonly BusEvent[]): void {}

  isActive(_ctx: StrategyContext): boolean {
    return false;
  }

  tick(_ctx: StrategyContext): ActionRequest[] {
    return [];
  }

  onEvent(_event: BusEvent, _ctx: StrategyContext): ActionRequest[] {
    return [];
  }

  suspend(): void {}

  inspect(): StrategyInspect {
    return { kind: 'reflex', view: { retired: true, route: 'hazard_decision_service' } };
  }
}
