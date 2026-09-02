import type { WorldStateView } from '../../../types.js';
import type { WorldFactRequest } from '../../contracts/worldFact.js';

export interface GoalAgentPerceptionPort {
  observe(signal: AbortSignal, factRequests?: readonly WorldFactRequest[]): Promise<WorldStateView>;
}
