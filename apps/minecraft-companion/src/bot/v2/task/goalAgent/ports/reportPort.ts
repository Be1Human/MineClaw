import type { GoalReportV2 } from '../../../decision/goalAgentPort/contracts.js';
import type { GoalAgentStateV1 } from '../goalAgentState.js';

export interface GoalAgentReportPort {
  publish(report: GoalReportV2, state: Readonly<GoalAgentStateV1>): void;
}
