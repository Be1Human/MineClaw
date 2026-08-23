export interface RootGoalVerdictSummary {
  detail?: string;
  evidenceRefs?: string[];
}

/** Keep root-goal end-state evidence separate from unverified execution-process claims. */
export function buildCompletedGoalSummary(verdict: RootGoalVerdictSummary | undefined): string {
  const refs = (verdict?.evidenceRefs ?? [])
    .map(value => value.trim())
    .filter(Boolean);
  const verified = refs.length > 0
    ? refs.join(', ')
    : verdict?.detail?.trim() || '根目标终态';
  return `机器判据已满足：${verified}。仅确认目标终态；当前没有可用于描述具体武器、进食、受伤或方块变化的过程证据。`;
}
