export type GoalAgentDeadlineScope = 'node' | 'session';

export class GoalAgentDeadlineExceededError extends Error {
  constructor(
    readonly scope: GoalAgentDeadlineScope,
    readonly timeoutMs: number,
  ) {
    super(`GoalAgent ${scope} deadline exceeded after ${timeoutMs}ms`);
    this.name = 'GoalAgentDeadlineExceededError';
  }
}

export interface GoalAgentDeadlineClock {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_GOAL_AGENT_DEADLINE_CLOCK: GoalAgentDeadlineClock = {
  setTimeout(callback, timeoutMs) { return globalThis.setTimeout(callback, timeoutMs); },
  clearTimeout(handle) { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** Fences late model/tool/physical completions by aborting the epoch controller at the deadline. */
export function runWithGoalAgentDeadline<T>(input: {
  operation: () => Promise<T>;
  controller: AbortController;
  scope: GoalAgentDeadlineScope;
  timeoutMs: number;
  clock?: GoalAgentDeadlineClock;
}): Promise<T> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    input.controller.abort();
    return Promise.reject(new GoalAgentDeadlineExceededError(input.scope, Math.max(0, input.timeoutMs)));
  }
  const clock = input.clock ?? SYSTEM_GOAL_AGENT_DEADLINE_CLOCK;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      input.controller.abort();
      reject(new GoalAgentDeadlineExceededError(input.scope, input.timeoutMs));
    }, input.timeoutMs);
    void input.operation().then(value => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(handle);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(handle);
      reject(error);
    });
  });
}
