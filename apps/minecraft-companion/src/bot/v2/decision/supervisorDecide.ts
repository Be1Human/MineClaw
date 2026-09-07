/**
 * 🧠 Supervisor · decide() 纯函数
 *
 * 接受 trigger + 只读 state + 只读 world + config + task snapshot
 * 返回 Action[] — 无副作用，可单元测试。
 */

import type { BusEvent, WorldStateView } from '../types.js';
import { isProjectionTask, type Task } from '../task/taskRuntime.js';
import type { Diagnosis } from './supervisor.js';
import type { SubtaskSuggestion } from '../task/subtaskInjector.js';
import { planRecovery } from './recoveryPlanner.js';

// ──────────────────────────────────────────────────────────────────
// SupervisorState
// ──────────────────────────────────────────────────────────────────

export interface SupervisorState {
  /** taskId → recoveryTaskId · 正在进行中的恢复子任务 */
  ongoingRecoveries: Map<string, string>;
  /** 最近的诊断记录（滑动窗口） */
  recentDiagnoses: Diagnosis[];
  /** taskId → 上次有进展的 tick */
  lastProgressTick: Map<string, number>;
  /** taskId → 恢复尝试次数 */
  recoveryAttempts: Map<string, number>;
  /** taskId → narration 上次发出的时间戳 ms */
  narrationCooldowns: Map<string, number>;
}

// ──────────────────────────────────────────────────────────────────
// SupervisorConfig
// ──────────────────────────────────────────────────────────────────

export interface SupervisorConfig {
  /** 多少 tick 没有进展算卡死（~10s at 5tick/s） */
  STUCK_TICK_THRESHOLD: number;
  /** 血量低于此值算危急 */
  HEALTH_CRITICAL_THRESHOLD: number;
  /** 相同诊断在多少 tick 内去重（防重复 emit） */
  DIAGNOSIS_DEDUP_WINDOW: number;
  /** 同一任务最多恢复多少次 */
  RECOVERY_MAX_ATTEMPTS: number;
  /** narration 同一任务最小间隔 ms */
  NARRATION_COOLDOWN_MS: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  STUCK_TICK_THRESHOLD: 300,  // 60s at 5tick/s · 给远距离导航足够时间
  HEALTH_CRITICAL_THRESHOLD: 6,
  DIAGNOSIS_DEDUP_WINDOW: 60,
  RECOVERY_MAX_ATTEMPTS: 2,
  NARRATION_COOLDOWN_MS: 3000,
};

// ──────────────────────────────────────────────────────────────────
// SupervisorInspect
// ──────────────────────────────────────────────────────────────────

export interface SupervisorInspect {
  ongoingRecoveries: Record<string, string>;
  recentDiagnoses: Diagnosis[];
  lastProgressTick: Record<string, number>;
  recoveryAttempts: Record<string, number>;
  narrationCooldowns: Record<string, number>;
}

// ──────────────────────────────────────────────────────────────────
// DecideTrigger
// ──────────────────────────────────────────────────────────────────

export type DecideTrigger =
  | { kind: 'event'; event: BusEvent }
  | { kind: 'watchdog'; tick: number };

// ──────────────────────────────────────────────────────────────────
// Action union
// ──────────────────────────────────────────────────────────────────

export type Action =
  | { kind: 'l6.fail'; taskId: string; reason: string }
  | { kind: 'l6.inject'; parentTaskId: string; suggestion: SubtaskSuggestion }
  | { kind: 'state.push_diagnosis'; diagnosis: Diagnosis }
  | { kind: 'hb.submitSay'; topic: string; priority?: number; text?: string }
  | { kind: 'bus.publish'; eventType: string; level: string; payload: unknown };

// ──────────────────────────────────────────────────────────────────
// decide() — pure function
// ──────────────────────────────────────────────────────────────────

export function decide(
  trigger: DecideTrigger,
  state: Readonly<SupervisorState>,
  world: WorldStateView | null,
  cfg: Readonly<SupervisorConfig>,
  tasks: { running: Task[]; paused: Task[] },
): Action[] {
  if (trigger.kind === 'event') {
    return decideOnEvent(trigger.event, state, world, cfg, tasks);
  }
  // watchdog
  return decideWatchdog(trigger.tick, state, cfg, tasks);
}

// ─────────────── event branch ───────────────

function decideOnEvent(
  event: BusEvent,
  state: Readonly<SupervisorState>,
  _world: WorldStateView | null,
  cfg: Readonly<SupervisorConfig>,
  tasks: { running: Task[]; paused: Task[] },
): Action[] {
  switch (event.type) {
    case 'under_attack':
    case 'danger_cleared':
      // Hazard ownership is selected by HazardDecisionService + the declared
      // Activity capability. Supervisor is intentionally not a control plane.
      return [];

    case 'task.preflight_failed':
    case 'supervisor.stuck_detected': {
      const payload = event.payload as { taskId?: string };
      const taskId = payload?.taskId;
      if (!taskId) return [];
      const runningTask = tasks.running.find(t => t.id === taskId);
      if (!runningTask) return [];
      const diag = makeDiagnosis(taskId, event);

      // FEAT-CROSS-06 · goal_exec 的失败恢复由 GoalAgent 独占。
      // Supervisor 只保留诊断观测，不得 fail / inject / ask，避免双写恢复决策。
      if (runningTask.kind === 'goal_exec') {
        return [{ kind: 'state.push_diagnosis', diagnosis: diag }];
      }

      // 持续性任务（follow_owner 等）stuck 时走恢复流程，不直接 fail
      if (runningTask.kind === 'follow_owner' || runningTask.kind === 'guard') {
        const verdict = planRecovery(diag, runningTask, null, cfg, state.recoveryAttempts);
        const actions: Action[] = [{ kind: 'state.push_diagnosis', diagnosis: diag }];
        if (verdict.kind === 'subtask') {
          actions.push({ kind: 'l6.inject', parentTaskId: runningTask.id, suggestion: verdict.suggestion });
        } else if (verdict.kind === 'abort') {
          actions.push({ kind: 'l6.fail', taskId, reason: verdict.reason });
        }
        // ask_master → 不做处理，等主人说话
        return actions;
      }

      // 非持续性任务：stuck 或 preflight_failed → 直接 fail
      const actions: Action[] = [
        { kind: 'state.push_diagnosis', diagnosis: diag },
      ];
      if (diag.category === 'stuck' || diag.category === 'precondition_lost') {
        actions.push({ kind: 'l6.fail', taskId, reason: diag.detail });
      }
      return actions;
    }

    case 'tool_broken':
      return decideToolBroken(event, state, cfg, tasks);

    default:
      return [];
  }
}

// ─────────────── watchdog branch ───────────────

function decideWatchdog(
  tick: number,
  state: Readonly<SupervisorState>,
  cfg: Readonly<SupervisorConfig>,
  tasks: { running: Task[] },
): Action[] {
  const actions: Action[] = [];
  for (const task of tasks.running) {
    // Defense in depth: callers must normally filter projections before
    // decide(), but the pure policy must never supervise a display-only task.
    if (isProjectionTask(task)) continue;
    const lastProgress = state.lastProgressTick.get(task.id);
    if (lastProgress != null && tick - lastProgress > cfg.STUCK_TICK_THRESHOLD) {
      actions.push({
        kind: 'bus.publish',
        eventType: 'supervisor.stuck_detected',
        level: 'recoverable',
        payload: {
          taskId: task.id,
          sinceTick: lastProgress,
          nowTick: tick,
        },
      });
    }
  }
  return actions;
}

function decideToolBroken(
  event: BusEvent,
  state: Readonly<SupervisorState>,
  cfg: Readonly<SupervisorConfig>,
  tasks: { running: Task[]; paused: Task[] },
): Action[] {
  const runningTask = tasks.running[0];
  if (!runningTask) return [];

  const toolName = (event.payload as { tool?: string })?.tool;
  const taskHoeName = (runningTask.params as Record<string, unknown>)?.hoeName as string | undefined;

  // 如果任务不依赖这把工具，跳过
  if (toolName && taskHoeName && toolName !== taskHoeName) return [];

  // 这个任务已经在恢复中？跳过
  if (state.ongoingRecoveries.has(runningTask.id)) return [];

  const diag: Diagnosis = {
    taskId: runningTask.id,
    category: 'resource_missing',
    detail: `tool_broken:${toolName ?? 'unknown'}`,
  };

  // FEAT-CROSS-06 · 原子失败会直接回灌 GoalAgent；Supervisor 仅记录，不做旧式恢复。
  if (runningTask.kind === 'goal_exec') {
    return [{ kind: 'state.push_diagnosis', diagnosis: diag }];
  }

  const verdict = planRecovery(diag, runningTask, null, cfg, state.recoveryAttempts);
  const actions: Action[] = [{ kind: 'state.push_diagnosis', diagnosis: diag }];

  if (verdict.kind === 'subtask') {
    actions.push({ kind: 'l6.inject', parentTaskId: runningTask.id, suggestion: verdict.suggestion });
    actions.push({
      kind: 'bus.publish',
      eventType: 'supervisor.recovery_started',
      level: 'info',
      payload: { taskId: runningTask.id, suggestion: verdict.suggestion },
    });
  } else if (verdict.kind === 'abort') {
    actions.push({ kind: 'l6.fail', taskId: runningTask.id, reason: verdict.reason });
    actions.push({
      kind: 'bus.publish',
      eventType: 'supervisor.escalate',
      level: 'recoverable',
      payload: { taskId: runningTask.id, reason: verdict.reason },
    });
  } else {
    // ask_master
    actions.push({
      kind: 'bus.publish',
      eventType: 'supervisor.ask_master',
      level: 'info',
      payload: { taskId: runningTask.id, reason: verdict.reason },
    });
  }

  return actions;
}

// ─────────────── helpers ───────────────

function makeDiagnosis(taskId: string, event: BusEvent): Diagnosis {
  if (event.type === 'task.preflight_failed') {
    return {
      taskId,
      category: 'precondition_lost',
      detail: `missing:${JSON.stringify(event.payload)}`,
    };
  }
  if (event.type === 'supervisor.stuck_detected') {
    return {
      taskId,
      category: 'stuck',
      detail: `no_progress:${JSON.stringify(event.payload)}`,
    };
  }
  return { taskId, category: 'unknown', detail: event.type };
}
