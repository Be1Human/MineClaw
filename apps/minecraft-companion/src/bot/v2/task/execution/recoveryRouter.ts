import type { FailureEnvelope } from '../contracts/failureEnvelope.js';

export type RecoveryRoute =
  | { kind: 'correct_proposal'; feedback: string }
  | { kind: 'satisfy_prerequisite'; requirement: string }
  | { kind: 'retry'; variant: string }
  | { kind: 'graph_replan_required'; reason: FailureEnvelope }
  | { kind: 'pause_owner'; question: string }
  | { kind: 'fail'; reason: FailureEnvelope };

export interface RecoveryRouterInput {
  failure: FailureEnvelope;
  attempt: number;
  maxAttempt: number;
}

/** Deterministic leaf recovery routing. It never parses human-readable detail. */
export class RecoveryRouter {
  route(input: RecoveryRouterInput): RecoveryRoute {
    const { failure, attempt, maxAttempt } = input;
    if (failure.category === 'contract') {
      return { kind: 'correct_proposal', feedback: failure.code };
    }
    if (failure.category === 'precondition') {
      return { kind: 'satisfy_prerequisite', requirement: failure.code };
    }
    if (!failure.retryable) {
      return failure.ownerActionable
        ? { kind: 'pause_owner', question: `需要外部处理：${failure.code}` }
        : { kind: 'fail', reason: failure };
    }
    if (attempt < maxAttempt) {
      return { kind: 'retry', variant: hintFor(failure) };
    }
    if (failure.ownerActionable) {
      return { kind: 'pause_owner', question: `自动恢复已耗尽，需要外部信息：${failure.code}` };
    }
    return { kind: 'graph_replan_required', reason: failure };
  }
}

function hintFor(failure: FailureEnvelope): string {
  switch (failure.category) {
    case 'resource':
      return '换资源点或扩大搜索范围';
    case 'navigation':
      return '重置寻路并选择不同路线';
    case 'environment':
      return '等待或避开当前环境阻断';
    case 'timeout':
      return '取消旧动作后重新规划';
    case 'transient':
      return '使用同目标的替代动作重试';
    default:
      return '重新生成动作提议';
  }
}
