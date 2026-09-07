import type { WorldStateView } from '../../../types.js';
import type { WorldFactRequest } from '../../contracts/worldFact.js';
import type { RegistrySnapshotRef } from '../../../plugin-sdk/identity.js';

export interface GoalAgentPerceptionPort {
  observe(signal: AbortSignal, factRequests?: readonly WorldFactRequest[], snapshot?: RegistrySnapshotRef): Promise<WorldStateView>;
}
