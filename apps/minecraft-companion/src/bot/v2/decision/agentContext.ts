import type { GoalReportV2, InteractionSessionV2 } from './goalAgentPort/contracts.js';

export const MAINBRAIN_CONTEXT_SCHEMA = 'mineclaw.mainbrain-context/v1' as const;

export interface MainBrainContextEnvelope {
  schema: typeof MAINBRAIN_CONTEXT_SCHEMA;
  interaction: Pick<InteractionSessionV2,'sessionId'|'origin'|'originalText'|'desiredOutcome'|'state'|'replyObligation'>;
  latestGoalReport: Pick<GoalReportV2,'requestId'|'status'|'summary'|'progress'|'evidence'>;
}

/** MainBrain 只拿交互/session 视图，不接收 GoalAgent 的 ReAct messages 或原子执行轨迹。 */
export function buildMainBrainContext(
  session: MainBrainContextEnvelope['interaction'],
  report: GoalReportV2,
): MainBrainContextEnvelope {
  return {
    schema:MAINBRAIN_CONTEXT_SCHEMA,
    interaction:{...session},
    latestGoalReport:{
      requestId:report.requestId,status:report.status,summary:report.summary,
      ...(report.progress?{progress:structuredClone(report.progress)}:{}),
      evidence:structuredClone(report.evidence),
    },
  };
}
