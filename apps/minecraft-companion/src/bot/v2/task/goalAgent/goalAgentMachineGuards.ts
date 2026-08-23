import type { GoalAgentStateV1 } from './goalAgentState.js';
import type {
  GoalAgentVerificationPort,
  GoalAgentVerificationResult,
} from './ports/verificationPort.js';

export interface GoalAgentMachineVerdictSnapshot {
  readonly schema: 'mineclaw.goal-agent-machine-verdict/v1';
  readonly planNodeId: string;
  readonly task: GoalAgentVerificationResult;
  readonly root: GoalAgentVerificationResult;
  readonly evidenceRefs: readonly string[];
}

/** Authoritative machine guard. Cognitive evaluation may explain it but cannot replace it. */
export async function verifyGoalAgentProgress(
  state: Readonly<GoalAgentStateV1>,
  planNodeId: string,
  verification: GoalAgentVerificationPort,
): Promise<GoalAgentMachineVerdictSnapshot> {
  const [task, root] = await Promise.all([
    verification.verifyTask({ state, planNodeId }),
    verification.verifyRoot({ state }),
  ]);
  assertVerificationResult('task', task);
  assertVerificationResult('root', root);
  return Object.freeze({
    schema: 'mineclaw.goal-agent-machine-verdict/v1',
    planNodeId,
    task: structuredClone(task),
    root: structuredClone(root),
    evidenceRefs: Object.freeze([...new Set([...task.evidenceRefs, ...root.evidenceRefs])]),
  });
}

function assertVerificationResult(scope: string, value: GoalAgentVerificationResult): void {
  if (typeof value.ok !== 'boolean' || !value.detail?.trim() || !Array.isArray(value.evidenceRefs)) {
    throw new Error(`GoalAgent ${scope} machine verifier returned an invalid result`);
  }
  if (value.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new Error(`GoalAgent ${scope} machine verifier returned an invalid evidenceRef`);
  }
}
