import type { WorldStateView } from '../../../types.js';

export interface GoalAgentPerceptionPort {
  observe(signal: AbortSignal): Promise<WorldStateView>;
}
