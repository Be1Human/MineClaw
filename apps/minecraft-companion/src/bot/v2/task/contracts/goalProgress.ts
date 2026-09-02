export interface GoalProgressState {
  schema: 'mineclaw.goal-progress/v1';
  mode: 'running' | 'recovery' | 'waiting_world' | 'paused_owner' | 'failed';
  rounds: number;
  noProgressRounds: number;
  totalNoProgressRounds: number;
  recoveryAttempts: number;
  recoveryStartedRound: number;
  emptySearchStreak: number;
  inactiveRounds: number;
  sentFeedbackKinds: string[];
  fingerprint: string | null;
  seenFingerprints: string[];
  lastProgressAt: number | null;
  catalogVersion: string;
  waitStartedAt: number | null;
  waiting: { key: string; reason: string; fingerprint: string; nextCheckAt: number; deadlineAt: number; checks: number; evidenceRefs: string[] } | null;
}
