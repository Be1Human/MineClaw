import { createHash } from 'node:crypto';
import type { CommittedAgentGoal, GoalSignature } from '../plannerContracts.js';
import { GoalTargetRegistry } from './goalTargetRegistry.js';

export class GoalSignatureCompiler {
  constructor(private readonly targets = new GoalTargetRegistry()) {}

  compile(goal: CommittedAgentGoal): GoalSignature {
    const definition = this.targets.get(goal.target.registryId);
    const constraintsHash = createHash('sha256')
      .update(JSON.stringify([...goal.constraints].sort()))
      .digest('hex')
      .slice(0, 16);
    const key = `${goal.outcome}:${goal.target.kind}:${goal.target.registryId}:${goal.target.quantity}`;
    return Object.freeze({
      key,
      outcome: goal.outcome,
      targetKind: goal.target.kind,
      targetId: goal.target.registryId,
      quantity: goal.target.quantity,
      constraintsHash,
      compatibleTaskFamilies: Object.freeze([...(definition?.taskFamilies ?? ['general'])]),
      schemaVersion: 1 as const,
    });
  }
}
