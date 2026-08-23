/**
 * 📋 L6 · Task Runtime 任务运行时（v2 · 最小集）
 *
 * 职责：
 *   - 任务实体的生命周期（pending → running → paused/completed/failed）
 *   - TaskScheduler（栈式，支持暂停/恢复/抢占）
 *   - PreflightChecker（前置检查）
 *   - TaskWatchdog（卡死/超时检测 · 上报给 Supervisor）
 *
 * 不做的：
 *   ❌ ActionRequest 仲裁（Heartbeat 的事）
 *   ❌ 失败诊断 / 补救（Supervisor 的事）
 *
 * 当前只实现 follow_owner 任务模板（其他模板留 registry hook）。
 */

import type { MemoryV2, TaskSnapshot } from '../infra/memory.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { WorldStateView } from '../types.js';
import { taskLabel } from '../knowledge/taskLabel.js';

/** 子任务建议（内联定义避免循环依赖 · 与 subtaskInjector.ts 中的 SubtaskSuggestion 同构） */
export interface SubtaskSuggestionInput {
  kind: string;
  params: Record<string, unknown>;
  priority?: number;
  timeoutMs?: number;
}

export type TaskState = TaskSnapshot['state'];
export type TaskFeedbackPolicy = 'user_visible' | 'internal' | 'silent';
export type TaskResumePolicy = 'automatic' | 'explicit';
export type TaskExecutionMode = 'scheduled' | 'projection';
const TASK_RESUME_POLICY_KEY = '__taskResumePolicy';

export function taskResumePolicyFromSnapshot(snapshot: TaskSnapshot): TaskResumePolicy | undefined {
  const value = snapshot.resumePoint?.[TASK_RESUME_POLICY_KEY];
  return value === 'automatic' || value === 'explicit' ? value : undefined;
}

function visibleResumePoint(resumePoint?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!resumePoint || !(TASK_RESUME_POLICY_KEY in resumePoint)) return resumePoint;
  const copy = { ...resumePoint };
  delete copy[TASK_RESUME_POLICY_KEY];
  return Object.keys(copy).length > 0 ? copy : undefined;
}

export interface Task {
  id: string;
  kind: string;
  state: TaskState;
  priority: number;
  /** 前置检查名 · 由 TaskRuntime 在 ⑤ 步骤里查 WorldState */
  preconditions: string[];
  /** 创建参数 · 不同 task 模板各自约定 */
  params: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  /** 上次活动 tick · TaskWatchdog 用 */
  lastActiveTick: number;
  /** Projection tasks are display-only state mirrors: never schedule, supervise or recover them. */
  executionMode?: TaskExecutionMode;
  /** 暂停时的断点上下文 · ResumeManager 用 */
  resumePoint?: Record<string, unknown>;
  parentId?: string;
  /** 正向授权：只有 user_visible 终态可唤醒 MainBrain；内部/恢复任务默认 internal。 */
  feedbackPolicy?: TaskFeedbackPolicy;
  feedbackRootId?: string;
  feedbackGeneration?: number;
  /** 任务运行时进度（Strategy 改 / TaskRuntime 读） */
  progress?: Record<string, unknown>;
  /** FEAT-L6-03 · complete() 被后置验证门拒绝的次数（≥3 转 failed，防死循环） */
  falseSuccessCount?: number;
  /** FEAT-L6-04 · 任务失败时的结构化原因（终态可观测 + 触发器退避用） */
  failure?: FailureReason;
  /** FEAT-WEBUI-08 · 人话意图（"去到金块"）· LLM 传 / taskLabel 模板兜底 · 仅展示用 */
  label?: string;
}

export function isProjectionTask(task: Pick<Task, 'executionMode'>): boolean {
  return task.executionMode === 'projection';
}

/** GuardTask 参数 */
export interface GuardTaskParams {
  /** 守卫中心坐标 */
  center: { x: number; y: number; z: number };
  /** 巡逻半径（格） */
  radius: number;
  /** 触发战斗的最大距离（默认 8） */
  combatRange?: number;
}

/** FarmTask 参数 */
export interface FarmTaskParams {
  /** 要种的作物种子物品名（如 'wheat_seeds'） */
  seedName: string;
  /** 需要犁的格子数（亩数 · 1 亩 = 配置 N 格，此处简化为格子数） */
  plots: number;
  /** 锄头物品名 */
  hoeName: string;
  /** 每犁 1 格的耐久消耗（按 mineflayer 实际 1 计） */
  durabilityPerPlot: number;
}

export interface PreflightResult {
  ok: boolean;
  missing: string[];
}

/** 根据 task kind 返回默认优先级（与模板 createXxxTask 保持一致） */
function priorityForKind(kind: string): number {
  switch (kind) {
    case 'follow_owner': return 40;
    case 'guard':        return 35;
    case 'farm':         return 30;
    default:             return 20;
  }
}

import type { PreconditionRegistry } from './preconditionRegistry.js';
import type { IPostconditionValidator } from './critic/types.js';
import { type FailureReason, toFailureReason, formatFailureReason } from './failureReason.js';

export class TaskRuntime {
  private tasks = new Map<string, Task>();
  /** 栈式调度：top 是当前激活任务 */
  private stack: string[] = [];
  /** 只有调度抢占产生的暂停可在抢占者终态后自动恢复。 */
  private readonly autoResumeEligible = new Set<string>();
  private idSeq = 0;

  constructor(
    private readonly memory: MemoryV2,
    private readonly bus: EventBusV2,
    private readonly preconditions?: PreconditionRegistry,
    /** FEAT-L6-03 · 后置验证门（不注入则 complete 直通=现状） */
    private readonly postValidator?: IPostconditionValidator,
    /** FEAT-L6-03 · 实时世界视图取数（避免快照过期误杀）· 返回 null 时跳过验证门 */
    private readonly worldView?: () => WorldStateView | null,
  ) {}

  // ─────────────── 持久化恢复 ───────────────

  /**
   * 从 TaskSnapshot（MemoryV2 持久化读取）重建 Task 对象并注册到运行时。
   * 供 Supervisor.hydrate() 使用——先 hydrateFromSnapshot，再调 resume()。
   *
   * 如果 id 已存在（同次进程内重复调用），不覆盖。
   */
  hydrateFromSnapshot(snap: TaskSnapshot): void {
    if (this.tasks.has(snap.taskId)) return;
    const task: Task = {
      id: snap.taskId,
      kind: snap.kind,
      // 仍为 paused·resume() 会把它改成 running 并推栈
      state: 'paused',
      priority: priorityForKind(snap.kind),
      preconditions: [],        // 恢复任务跳过 preflight
      params: {},
      createdAt: snap.createdAt,
      lastActiveTick: 0,
      resumePoint: visibleResumePoint(snap.resumePoint),
      parentId: snap.parentId,
      feedbackPolicy: snap.feedbackPolicy ?? 'internal',
      feedbackRootId: snap.feedbackRootId ?? snap.taskId,
      feedbackGeneration: snap.feedbackGeneration ?? 0,
    };
    this.tasks.set(snap.taskId, task);
  }

  // ─────────────── 通用创建 ───────────────

  /** 统一任务创建接口 · 由 Task Registry + Dispatcher 驱动 */
  createTask(kind: string, params: Record<string, unknown>, overrides?: {
    priority?: number;
    preconditions?: string[];
    parentId?: string;
    label?: string;
    feedbackPolicy?: TaskFeedbackPolicy;
    feedbackRootId?: string;
    feedbackGeneration?: number;
  }): Task {
    const id = `task-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind,
      state: 'pending',
      priority: overrides?.priority ?? priorityForKind(kind),
      preconditions: overrides?.preconditions ?? [],
      params,
      createdAt: Date.now(),
      lastActiveTick: 0,
      parentId: overrides?.parentId,
      feedbackPolicy: overrides?.feedbackPolicy ?? 'internal',
      feedbackRootId: overrides?.feedbackRootId ?? id,
      feedbackGeneration: overrides?.feedbackGeneration ?? 0,
      // FEAT-WEBUI-08 · 人话意图：LLM 传 label / taskLabel 模板兜底
      label: overrides?.label ?? taskLabel(kind, params),
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.bus.publish('task.created', 'info', { taskId: id, kind });
    return task;
  }

  // ─────────────── 任务模板（兼容旧代码，内部转调 createTask）───────────────

  createFollowOwnerTask(params: { ownerName: string }): Task {
    const id = `task-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind: 'follow_owner',
      state: 'pending',
      priority: 40,
      preconditions: ['owner_known'],
      params,
      createdAt: Date.now(),
      lastActiveTick: 0,
      feedbackPolicy: 'internal',
      feedbackRootId: id,
      feedbackGeneration: 0,
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.bus.publish('task.created', 'info', { taskId: id, kind: task.kind });
    return task;
  }

  createFarmTask(params: FarmTaskParams): Task {
    const id = `task-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind: 'farm',
      state: 'pending',
      priority: 30,
      // farm 的 preflight 检查：手上有 hoe + 耐久够 plots
      // 这里只放标签 · 真实检查在 checkPreflight 里按 kind 跑
      preconditions: ['has_seeds', 'has_hoe_with_durability'],
      params: { ...params } as unknown as Record<string, unknown>,
      createdAt: Date.now(),
      lastActiveTick: 0,
      progress: { plotsDone: 0 },
      feedbackPolicy: 'internal',
      feedbackRootId: id,
      feedbackGeneration: 0,
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.bus.publish('task.created', 'info', { taskId: id, kind: task.kind });
    return task;
  }

  createGuardTask(params: GuardTaskParams): Task {
    const id = `task-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind: 'guard',
      state: 'pending',
      priority: 35,
      preconditions: [], // 守卫任务无前置条件
      params: { ...params } as unknown as Record<string, unknown>,
      createdAt: Date.now(),
      lastActiveTick: 0,
      feedbackPolicy: 'internal',
      feedbackRootId: id,
      feedbackGeneration: 0,
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.bus.publish('task.created', 'info', { taskId: id, kind: task.kind });
    return task;
  }

  /**
   * 创建子任务（由 SubtaskInjector 调用）
   * 子任务 state=pending · parentId 指向父任务 · 不做 preflight
   */
  createSubtask(suggestion: SubtaskSuggestionInput, parentId: string): Task {
    const id = `task-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind: suggestion.kind,
      state: 'pending',
      priority: suggestion.priority ?? 50,
      preconditions: [], // 子任务跳过 preflight（由注入方保证条件）
      params: { ...suggestion.params },
      createdAt: Date.now(),
      lastActiveTick: 0,
      parentId,
      feedbackPolicy: 'internal',
      feedbackRootId: parentId,
      feedbackGeneration: 0,
      // FEAT-WEBUI-08 · 子任务也带人话意图（递归合成的采料/造工具子任务）
      label: taskLabel(suggestion.kind, suggestion.params),
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.bus.publish('task.created', 'info', { taskId: id, kind: task.kind, parentId });
    return task;
  }

  // ─────────────── 原子镜像节点（纯展示 · FEAT-WEBUI-09）───────────────
  //
  // goalAgent 派发 invoke_atomic / invoke_behavior 时，建一个挂在 goal_exec 父任务下的
  // 子节点，**仅供任务树实时可视化**拆解过程（goto→dig→craft…）。
  // 三不原则：① 不入栈（调度器永不执行它，无双重执行）；② 不持久化（不写 DB/不参与重启恢复）；
  //          ③ 不发 task.* 事件（不触发 Critic 评测 / Supervisor 重试）。
  // 前端靠 2s 轮询 /api/v2/tasks 自然刷新；session 结束由 pruneMirrors 清理。

  /** 建一个 running 的镜像子节点，返回其 id */
  mirrorStart(kind: string, params: Record<string, unknown>, parentId: string, label: string): string {
    const id = `mirror-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind,
      state: 'running',
      priority: 35,
      preconditions: [],
      params,
      createdAt: Date.now(),
      lastActiveTick: 0,
      executionMode: 'projection',
      startedAt: Date.now(),
      parentId,
      label,
      feedbackPolicy: 'silent',
      feedbackRootId: parentId,
      feedbackGeneration: 0,
    };
    this.tasks.set(id, task);
    return id;
  }

  /** Create one non-executing PlanGraph projection node for the task tree. */
  mirrorPlanNode(
    kind: string,
    params: Record<string, unknown>,
    parentId: string,
    label: string,
    state: TaskState,
  ): string {
    const id = `mirror-${++this.idSeq}-${Date.now()}`;
    const task: Task = {
      id,
      kind,
      state,
      priority: 34,
      preconditions: [],
      params,
      createdAt: Date.now(),
      lastActiveTick: 0,
      executionMode: 'projection',
      ...(state === 'running' ? { startedAt: Date.now() } : {}),
      parentId,
      label,
      feedbackPolicy: 'silent',
      feedbackRootId: parentId,
      feedbackGeneration: 0,
    };
    this.tasks.set(id, task);
    return id;
  }

  /** Update a PlanGraph projection node without entering the scheduler. */
  mirrorSetState(id: string, state: TaskState, detail?: string): void {
    const task = this.tasks.get(id);
    if (!task || !id.startsWith('mirror-')) return;
    if (isTerminalTaskState(task.state)) return;
    task.state = state;
    if (state === 'running' && !task.startedAt) task.startedAt = Date.now();
    if (state === 'failed' && detail) task.failure = toFailureReason(detail);
  }

  /** 镜像子节点终态：原子 resolve 后置 completed / failed（无栈/父恢复副作用） */
  mirrorFinish(id: string, ok: boolean, detail: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (isTerminalTaskState(t.state)) return;
    t.state = ok ? 'completed' : 'failed';
    if (!ok) t.failure = toFailureReason(detail || 'atom_failed');
  }

  /** 清掉某父任务下的所有镜像子节点（session 终态调用，避免堆进归档/内存） */
  pruneMirrors(parentId: string): void {
    for (const [id, t] of this.tasks) {
      if (t.parentId === parentId && id.startsWith('mirror-')) this.tasks.delete(id);
    }
  }

  /**
   * 把已有任务 id 压入栈顶，并将其设为 running（跳过 preflight）
   * 供 SubtaskInjector 调用，使子任务立即成为 active。
   */
  pushToStack(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    this.autoResumeEligible.delete(taskId);
    t.state = 'running';
    t.startedAt = Date.now();
    this.stack.push(taskId);
    this.persist(t);
    this.bus.publish('task.started', 'info', { taskId, kind: t.kind });
  }

  /** 任务参数更新（如 ask_master 答复后调整 plots） */
  updateParams(taskId: string, patch: Partial<Record<string, unknown>>): boolean {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    t.params = { ...t.params, ...patch };
    this.persist(t);
    this.bus.publish('task.params_updated', 'info', { taskId, patch });
    return true;
  }

  // ─────────────── 调度 ───────────────

  /** 启动任务 · 入栈成为当前 active · 经过 preflight */
  start(taskId: string, world: WorldStateView): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, reason: 'task_not_found' };
    const preflight = this.checkPreflight(t, world);
    if (!preflight.ok) {
      this.bus.publish('task.preflight_failed', 'recoverable', {
        taskId,
        missing: preflight.missing,
      });
      return { ok: false, reason: `preflight_missing:${preflight.missing.join(',')}` };
    }

    // ★ 自动挂起栈中优先级 ≤ 新任务的 running 任务（非子任务）
    for (const stackedId of [...this.stack]) {
      const stacked = this.tasks.get(stackedId);
      if (stacked && stacked.state === 'running' && stacked.priority <= t.priority && !stacked.parentId) {
        this.pause(stackedId, { pausedBy: taskId, reason: 'preempted' }, 'automatic');
      }
    }

    this.autoResumeEligible.delete(taskId);
    t.state = 'running';
    t.startedAt = Date.now();
    this.stack.push(taskId);
    this.persist(t);
    this.bus.publish('task.started', 'info', { taskId, kind: t.kind });
    return { ok: true };
  }

  /**
   * FEAT-CROSS-05 · 启动「紧急任务」· 跳过 preflight + 抢占栈中低优任务 + 入栈成为 active。
   * 用于反射级紧急情况（脱困/逃跑/避岩浆）：必须先注册任务再执行，任务树可见；
   * 结束(complete/fail)时栈空 → tryResumeHighestPaused 自动恢复被抢占的原任务。
   */
  startEmergency(taskId: string): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, reason: 'task_not_found' };
    // 已在栈中 running → 幂等
    if (t.state === 'running' && this.stack.includes(taskId)) return { ok: true };
    // 抢占：挂起栈中 priority ≤ 本任务的 running 任务（非子任务）
    for (const stackedId of [...this.stack]) {
      const stacked = this.tasks.get(stackedId);
      if (stacked && stacked.state === 'running' && stacked.priority <= t.priority && !stacked.parentId) {
        this.pause(stackedId, { pausedBy: taskId, reason: 'preempted_emergency' }, 'automatic');
      }
    }
    this.autoResumeEligible.delete(taskId);
    t.state = 'running';
    t.startedAt = Date.now();
    if (!this.stack.includes(taskId)) this.stack.push(taskId);
    this.persist(t);
    this.bus.publish('task.started', 'info', { taskId, kind: t.kind, emergency: true });
    return { ok: true };
  }

  /** FEAT-CROSS-05 · 某任务是否 running（反射策略判断自己的紧急任务是否还在） */
  isRunning(taskId: string): boolean {
    return this.tasks.get(taskId)?.state === 'running';
  }

  /** Supervisor 调用 · 暂停当前任务 · 保留断点 */
  pause(
    taskId: string,
    resumePoint?: Record<string, unknown>,
    resumePolicy: TaskResumePolicy = 'explicit',
  ): void {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'running') return;
    t.state = 'paused';
    t.resumePoint = resumePoint;
    if (resumePolicy === 'automatic') this.autoResumeEligible.add(taskId);
    else this.autoResumeEligible.delete(taskId);
    // 从栈中移除已暂停的任务（使其不再 active）
    this.stack = this.stack.filter(x => x !== taskId);
    this.persist(t);
    this.bus.publish('task.paused', 'info', { taskId });
  }

  /** Supervisor 调用 · 恢复任务 */
  resume(taskId: string): { ok: boolean; resumePoint?: Record<string, unknown> } {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'paused') return { ok: false };
    this.autoResumeEligible.delete(taskId);
    t.state = 'running';
    t.lastActiveTick = 0;
    // 关键修复 #1：恢复时必须入栈，使任务重新激活（被 pause() 移出栈的任务需要重新入栈）
    if (!this.stack.includes(taskId)) {
      this.stack.push(taskId);
    }
    this.persist(t);
    this.bus.publish('task.resumed', 'info', { taskId });
    return { ok: true, resumePoint: t.resumePoint };
  }

  complete(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;

    // FEAT-L6-03 · 后置验证门：防假成功。
    // 只看实时 after 世界视图；没注册后置验证器的 kind → unknown 放行（零误杀）。
    // 已 completed/failed 的任务不再验（幂等，防 Heartbeat 重复调）。
    if (this.postValidator && this.worldView && t.state !== 'completed' && t.state !== 'failed') {
      const w = this.worldView();
      if (w) {
        const v = this.postValidator.verifyPostcondition(t, w);
        if (v.status === 'fail') {
          t.falseSuccessCount = (t.falseSuccessCount ?? 0) + 1;
          this.bus.publish('task.false_success', 'recoverable', {
            taskId,
            kind: t.kind,
            reason: v.reason,
            attempt: t.falseSuccessCount,
          });
          // 连续 3 次拒绝 → 走既有失败/重试体系（防死循环 · 不卡 watchdog）
          if (t.falseSuccessCount >= 3) this.fail(taskId, { code: 'false_success', detail: `×3: ${v.reason}` });
          return; // 拒绝提交，任务保持 running 继续干
        }
      }
    }

    t.state = 'completed';
    this.autoResumeEligible.delete(taskId);
    this.stack = this.stack.filter(x => x !== taskId);
    this.persist(t);
    this.bus.publish('task.completed', 'info', this.terminalPayload(t));

    // 子任务完成后自动恢复父任务
    if (t.parentId) {
      const parent = this.tasks.get(t.parentId);
      if (parent && parent.state === 'paused') {
        this.resume(t.parentId);
        this.bus.publish('task.subtask_done', 'info', {
          subtaskId: taskId,
          parentTaskId: t.parentId,
          kind: t.kind,
        });
      }
    } else if (this.stack.length === 0) {
      // ★ 普通任务完成且栈空 → 恢复之前被抢占挂起的最高优先级任务
      this.tryResumeHighestPaused();
    }
  }

  /**
   * 任务失败（FEAT-L6-04）· 兼容旧签名：传 string 自动包成 {code:'unknown', detail}。
   * task.failed payload 同时带结构化 code/detail 与旧的 reason 文本（向后兼容消费者）。
   */
  fail(taskId: string, reason: FailureReason | string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const failure = toFailureReason(reason);
    t.state = 'failed';
    this.autoResumeEligible.delete(taskId);
    t.failure = failure;
    this.stack = this.stack.filter(x => x !== taskId);
    this.persist(t);
    this.bus.publish('task.failed', 'recoverable', {
      ...this.terminalPayload(t),
      code: failure.code,
      detail: failure.detail,
      reason: formatFailureReason(failure), // 旧消费者（mainBrain 摘要等）仍读 reason
    });

    // 子任务失败后自动恢复父任务（不让父任务永远 paused）
    if (t.parentId) {
      const parent = this.tasks.get(t.parentId);
      if (parent && parent.state === 'paused') {
        parent.state = 'running';
        parent.lastActiveTick = 0;
        // 注意：pause() 不从栈中移除，所以父任务仍在栈里
        // 只有当父任务不在栈中时才 push（防止重复）
        if (!this.stack.includes(parent.id)) {
          this.stack.push(parent.id);
        }
        this.persist(parent);
        this.bus.publish('task.resumed', 'info', { taskId: t.parentId, resumedAfterSubtaskFail: true });
      }
    } else if (this.stack.length === 0) {
      // ★ 普通任务失败且栈空 → 恢复之前被抢占挂起的最高优先级任务
      this.tryResumeHighestPaused();
    }
  }

  /**
   * 任务取消（主人主动喊停）· 与 fail() 的本质区别：这是【成功满足主人意愿】，不是失败。
   *
   * 走独立 'cancelled' 终态，不写 failure、发 task.cancelled（info）而非 task.failed（recoverable）：
   *   - Supervisor 不会把它当失败去恢复/重试（主人说停就该停）
   *   - GoalAgent 内部 Critic 只评 completed/failed → cancelled 不进评测
   * 栈清理与父子恢复口径与 fail() 一致。
   */
  cancel(taskId: string, reason?: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.state = 'cancelled';
    this.autoResumeEligible.delete(taskId);
    this.stack = this.stack.filter(x => x !== taskId);
    this.persist(t);
    this.bus.publish('task.cancelled', 'info', {
      ...this.terminalPayload(t),
      reason: reason ?? 'cancelled_by_owner',
    });

    // 取消子任务后自动恢复父任务（与 fail 同口径，不让父任务永远 paused）
    if (t.parentId) {
      const parent = this.tasks.get(t.parentId);
      if (parent && parent.state === 'paused') {
        parent.state = 'running';
        parent.lastActiveTick = 0;
        if (!this.stack.includes(parent.id)) {
          this.stack.push(parent.id);
        }
        this.persist(parent);
        this.bus.publish('task.resumed', 'info', { taskId: t.parentId, resumedAfterSubtaskCancel: true });
      }
    } else if (this.stack.length === 0) {
      // 普通任务取消且栈空 → 恢复之前被抢占挂起的最高优先级任务
      this.tryResumeHighestPaused();
    }
  }

  // ─────────────── 每 tick 推进 ───────────────

  /** Heartbeat ⑤ TaskSched · 推进状态机 · 返回当前 active task */
  sched(tick: number, _world: WorldStateView): Task | null {
    const t = this.active();
    if (!t) return null;
    t.lastActiveTick = tick;

    // BUG-L7-01 R2：子任务超时自动 fail（防止无实现的子任务卡死父任务）
    const timeoutMs = (t.params as Record<string, unknown>)._timeoutMs as number | undefined;
    if (timeoutMs && t.startedAt && Date.now() - t.startedAt > timeoutMs) {
      this.fail(t.id, { code: 'stall_no_progress', detail: 'subtask_timeout' });
      return this.active(); // 父任务恢复后成为新 active
    }

    // 任务级 watchdog：跑了 30s 还没完成且没活动信号 → 上报
    if (t.startedAt && Date.now() - t.startedAt > 30000) {
      // 这里仅 emit · Supervisor 决定是否打断
      this.bus.publish('task.long_running', 'info', {
        taskId: t.id,
        kind: t.kind,
        elapsedMs: Date.now() - t.startedAt,
      });
    }

    // follow_owner 自完成判定：已贴近且持续 N tick 没远离 → 不需要在这判，留给上层
    return t;
  }

  // ─────────────── 查询 ───────────────

  active(): Task | null {
    const id = this.stack[this.stack.length - 1];
    if (!id) return null;
    const t = this.tasks.get(id);
    if (!t || t.state !== 'running') return null;
    return t;
  }

  getById(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  // ─────────────── private ───────────────

  /**
   * 栈空时自动恢复被抢占挂起的最高优先级任务。
   * 仅恢复非子任务（子任务的恢复由 parentId 链路处理）。
   */
  private tryResumeHighestPaused(): void {
    const candidates = this.list()
      .filter(t => t.state === 'paused' && !t.parentId && this.autoResumeEligible.has(t.id))
      .sort((a, b) => b.priority - a.priority);
    if (candidates.length > 0) {
      this.resume(candidates[0].id);
    }
  }

  private checkPreflight(t: Task, world: WorldStateView): PreflightResult {
    if (this.preconditions) {
      return this.preconditions.check(t.preconditions, t, world);
    }
    // 无注册表时全部通过（兼容测试场景）
    return { ok: true, missing: [] };
  }

  /** 给外部模块（如 Resolver / Supervisor）查 preflight · 不改任务状态 */
  preflight(taskId: string, world: WorldStateView): PreflightResult {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, missing: ['task_not_found'] };
    return this.checkPreflight(t, world);
  }

  private persist(t: Task): void {
    const resumePoint = t.state === 'paused'
      ? {
          ...(t.resumePoint ?? {}),
          [TASK_RESUME_POLICY_KEY]: this.autoResumeEligible.has(t.id) ? 'automatic' : 'explicit',
        }
      : t.resumePoint;
    this.memory.scheduleCommit('task', {
      taskId: t.id,
      kind: t.kind,
      state: t.state,
      resumePoint,
      parentId: t.parentId,
      feedbackPolicy: t.feedbackPolicy,
      feedbackRootId: t.feedbackRootId,
      feedbackGeneration: t.feedbackGeneration,
      createdAt: t.createdAt,
      updatedAt: Date.now(),
    } satisfies TaskSnapshot);
  }

  private terminalPayload(t: Task): Record<string, unknown> {
    return {
      taskId: t.id,
      kind: t.kind,
      feedbackPolicy: t.feedbackPolicy ?? 'internal',
      feedbackRootId: t.feedbackRootId ?? t.id,
      feedbackGeneration: t.feedbackGeneration ?? 0,
    };
  }
}

function isTerminalTaskState(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
