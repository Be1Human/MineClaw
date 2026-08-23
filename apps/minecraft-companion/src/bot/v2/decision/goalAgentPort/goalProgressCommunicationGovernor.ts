import type { GoalProgressUpdateKindV2, GoalReportV2 } from './contracts.js';

export type GoalProgressReportLevel = 'quiet' | 'balanced' | 'talkative';

export type GoalProgressGovernanceReason =
  | 'allowed'
  | 'not_applicable'
  | 'level_filtered'
  | 'duplicate'
  | 'cooldown'
  | 'task_budget'
  | 'hour_budget';

export interface GoalProgressGovernanceDecision {
  allowed: boolean;
  level: GoalProgressReportLevel;
  reason: GoalProgressGovernanceReason;
}

export interface GoalProgressCommunicationGovernorOptions {
  level?: GoalProgressReportLevel;
  now?: () => number;
}

interface LevelPolicy {
  allowedKinds: ReadonlySet<GoalProgressUpdateKindV2>;
  cooldownMs: number;
  taskBudget: number;
  hourBudget: number;
}

const POLICIES: Record<GoalProgressReportLevel, LevelPolicy> = {
  quiet: {
    allowedKinds: new Set(), cooldownMs: Number.POSITIVE_INFINITY, taskBudget: 0, hourBudget: 0,
  },
  balanced: {
    allowedKinds: new Set(['obstacle', 'decision']), cooldownMs: 45_000, taskBudget: 3, hourBudget: 12,
  },
  talkative: {
    allowedKinds: new Set(['milestone', 'obstacle', 'decision', 'recovery', 'resolved']),
    cooldownMs: 12_000, taskBudget: 12, hourBudget: 48,
  },
};

/** Deterministic attention policy. It never creates facts and never writes player-visible speech. */
export class GoalProgressCommunicationGovernor {
  private readonly level: GoalProgressReportLevel;
  private readonly now: () => number;
  private readonly seen = new Set<string>();
  private readonly taskCounts = new Map<string, number>();
  private readonly taskLastAllowedAt = new Map<string, number>();
  private hourlyAllowedAt: number[] = [];

  constructor(options: GoalProgressCommunicationGovernorOptions = {}) {
    this.level = options.level ?? 'balanced';
    this.now = options.now ?? (() => Date.now());
  }

  evaluate(report: GoalReportV2): GoalProgressGovernanceDecision {
    if (report.status !== 'running' || !report.update) return this.decision(false, 'not_applicable');
    const update = report.update;
    const dedupeKey = `${report.requestId}:${update.dedupeKey}`;
    if (this.seen.has(dedupeKey)) return this.decision(false, 'duplicate');
    this.seen.add(dedupeKey);

    const policy = POLICIES[this.level];
    if (!policy.allowedKinds.has(update.kind)) return this.decision(false, 'level_filtered');

    const taskCount = this.taskCounts.get(report.requestId) ?? 0;
    if (taskCount >= policy.taskBudget) return this.decision(false, 'task_budget');

    const now = this.now();
    this.hourlyAllowedAt = this.hourlyAllowedAt.filter(at => now - at < 60 * 60 * 1_000);
    if (this.hourlyAllowedAt.length >= policy.hourBudget) return this.decision(false, 'hour_budget');

    const lastAllowedAt = this.taskLastAllowedAt.get(report.requestId);
    if (lastAllowedAt !== undefined && now - lastAllowedAt < policy.cooldownMs) {
      return this.decision(false, 'cooldown');
    }

    this.taskCounts.set(report.requestId, taskCount + 1);
    this.taskLastAllowedAt.set(report.requestId, now);
    this.hourlyAllowedAt.push(now);
    return this.decision(true, 'allowed');
  }

  release(requestId: string): void {
    this.taskCounts.delete(requestId);
    this.taskLastAllowedAt.delete(requestId);
    for (const key of this.seen) {
      if (key.startsWith(`${requestId}:`)) this.seen.delete(key);
    }
  }

  private decision(allowed: boolean, reason: GoalProgressGovernanceReason): GoalProgressGovernanceDecision {
    return { allowed, level: this.level, reason };
  }
}
