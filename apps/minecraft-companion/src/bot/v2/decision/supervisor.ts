/**
 * 🛡 L7' Runtime Supervisor 运行时监督
 *
 * 与 MainBrain 对称的"被动反馈侧"：
 *   - 吃 EventBus 的 Critical / Recoverable 事件
 *   - 监督 L6 任务执行（卡死/超时/异常）
 *   - 调用 L6.TaskRuntime.pause/resume 落地，不亲自动手
 *
 * 当前场景（跟着我）的核心责任：
 *   ① 苦力怕来袭 → 暂停 FollowTask · 记断点
 *   ② Reflex 反击完毕（danger_cleared 事件）→ 恢复 FollowTask
 *   ③ 任务卡死（task.long_running 30s 没进展）→ 诊断并触发恢复
 *
 * 架构：onEvent/watchdog → decide() 纯函数 → commit() 副作用执行
 */

import type { EventBusV2 } from '../infra/eventBus.js';
import type { MemoryV2 } from '../infra/memory.js';
import type { BusEvent } from '../types.js';
import type { PerceptionPipeline } from '../perception/pipeline.js';
import { isProjectionTask, type TaskRuntime } from '../task/taskRuntime.js';
import type { ISubtaskInjector } from '../task/subtaskInjector.js';
import {
  decide,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorState,
  type SupervisorConfig,
  type SupervisorInspect,
} from './supervisorDecide.js';
import { commit } from './supervisorCommit.js';
import { reconcileTaskSnapshots } from './runtimeStateReconciler.js';

export interface Diagnosis {
  taskId: string;
  category: 'stuck' | 'timeout' | 'precondition_lost' | 'interrupted' | 'resource_missing' | 'unknown';
  detail: string;
}

/** Heartbeat 的对外提交口 · 用接口避开循环依赖 */
export interface NarrationSink {
  submitSay(source: string, text: string, priority?: number): void;
  /** FEAT-NARR-01 · 经统一语言中枢上报结构化通知（优先于 submitSay）*/
  narrate?(intent: import('../narration/types.js').SpeechIntent): void;
}

export class RuntimeSupervisor {
  private unsubs: Array<() => void> = [];
  /** 可选 · Heartbeat 装配后注入 · 让 Supervisor 能 say */
  private narration: NarrationSink | null = null;
  /** 可选 · v2Runtime 装配后通过 setter 注入 */
  private injector: ISubtaskInjector | null = null;

  /** Supervisor 全量状态（decide() 只读 · commit() 写） */
  private readonly state: SupervisorState = {
    suspendedByDanger: new Set<string>(),
    ongoingRecoveries: new Map<string, string>(),
    recentDiagnoses: [],
    lastProgressTick: new Map<string, number>(),
    recoveryAttempts: new Map<string, number>(),
    narrationCooldowns: new Map<string, number>(),
  };

  /** 配置阈值（可被测试注入覆盖） */
  private readonly cfg: SupervisorConfig = DEFAULT_SUPERVISOR_CONFIG;

  constructor(
    private readonly bus: EventBusV2,
    private readonly memory: MemoryV2,
    private readonly tasks: TaskRuntime,
    private readonly perception: PerceptionPipeline,
  ) {
    this.subscribe();
  }

  /** v2Runtime 装配末尾调用 · 把 Heartbeat 作为 narration sink 注入 */
  attachNarrationSink(sink: NarrationSink): void {
    this.narration = sink;
  }

  /** v2Runtime 装配末尾调用 · 注入 SubtaskInjector */
  setInjector(injector: ISubtaskInjector): void {
    this.injector = injector;
  }

  /** 供内部或外部模块访问 injector（可选链安全调用） */
  getInjector(): ISubtaskInjector | null {
    return this.injector;
  }

  /**
   * 启动时调一次 · 扫 Memory 里 state=paused 的 task · 自动 resume（US-C2）
   * v2Runtime.start() 末尾调用
   */
  hydrate(): void {
    const plan = reconcileTaskSnapshots(this.memory.query('task'));
    const restoredTaskIds: string[] = [];
    const dormantTaskIds: string[] = [];
    const discardedProjectionIds: string[] = [];
    const interruptedTaskIds: string[] = [];
    for (const snap of plan.interrupted) {
      // 旧进程的执行 handle 不存在，禁止把 Memory.running 直接当成活任务。
      this.memory.record('task',{...snap,state:'failed',updatedAt:Date.now()});
      interruptedTaskIds.push(snap.taskId);
      this.bus.publish('task.interrupted','recoverable',{taskId:snap.taskId,kind:snap.kind,previousState:snap.state,reason:'runtime_handle_lost_on_restart'});
    }
    for (const snap of plan.discardedProjections) {
      // goal_exec 只是 Planner/GoalAgent 的 L6 投影；重启后由 PlanRun 恢复重新创建，旧投影不得自行复活。
      this.memory.record('task',{...snap,state:'cancelled',updatedAt:Date.now()});
      discardedProjectionIds.push(snap.taskId);
    }
    for (const snap of plan.dormant) {
      // need_owner/手工暂停等显式恢复态只重建可见投影，不绕过业务层恢复。
      this.tasks.hydrateFromSnapshot(snap);
      dormantTaskIds.push(snap.taskId);
    }
    for (const snap of plan.resumable) {
      // 先把快照还原进 TaskRuntime（新进程 tasks Map 为空），再 resume
      this.tasks.hydrateFromSnapshot(snap);
      const result = this.tasks.resume(snap.taskId);
      if (result.ok) {
        restoredTaskIds.push(snap.taskId);
      }
    }
    this.bus.publish('supervisor.hydrated', 'info', {
      restoredTaskIds,
      dormantTaskIds,
      discardedProjectionIds,
      interruptedTaskIds,
    });
  }

  shutdown(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  // ─────────────── ③ Watchdog 步骤 · 每 tick Heartbeat 调用 ───────────────

  /** 各层自检 · 当前实现：扫 L6 任务的 long_running 等情况 */
  watchdog(tick: number): void {
    // 更新每个 running 任务的 lastProgressTick
    // 关键修复 BUG-L7-01：不再只首次写入，而是当任务有活动时持续刷新
    const allTasks = this.tasks.list();
    const supervisedTasks = allTasks.filter(task => !isProjectionTask(task));
    const runningTasks = supervisedTasks.filter(t => t.state === 'running');
    for (const t of runningTasks) {
      const recorded = this.state.lastProgressTick.get(t.id);
      if (recorded == null) {
        // 首次遇到
        this.state.lastProgressTick.set(t.id, tick);
      } else if (t.lastActiveTick > 0 && t.lastActiveTick >= recorded) {
        // 任务被 Heartbeat sched() 激活过 → 有进展 → 刷新
        this.state.lastProgressTick.set(t.id, tick);
      }
      // else: 任务 lastActiveTick 没变（如子任务占了栈顶）→ 不刷新 → 积累到阈值后 stuck
    }

    const actions = decide(
      { kind: 'watchdog', tick },
      this.state,
      this.perception.getWorldState(),
      this.cfg,
      {
        running: runningTasks,
        paused: supervisedTasks.filter(t => t.state === 'paused'),
      },
    );
    commit(actions, this.state, {
      tasks: this.tasks,
      narration: this.narration,
      bus: this.bus,
      injector: this.injector,
    });

    // BUG-L7-02 · 危险解除持续轮询：每次 watchdog tick 检查是否可恢复
    if (this.state.suspendedByDanger.size > 0) {
      this.tryClearDanger();
    }
  }

  /** 当前状态快照（供调试 / inspect 接口使用） */
  inspect(): SupervisorInspect {
    const { state } = this;
    return {
      suspendedByDanger: Array.from(state.suspendedByDanger),
      ongoingRecoveries: Object.fromEntries(state.ongoingRecoveries),
      recentDiagnoses: [...state.recentDiagnoses],
      lastProgressTick: Object.fromEntries(state.lastProgressTick),
      recoveryAttempts: Object.fromEntries(state.recoveryAttempts),
      narrationCooldowns: Object.fromEntries(state.narrationCooldowns),
    };
  }

  // ─────────────── 订阅 ───────────────

  private subscribe(): void {
    // Critical: under_attack → 暂停 Follow
    this.unsubs.push(
      this.bus.onLevel('critical', ev => this.onEvent(ev)),
    );
    // Recoverable: tool_broken / stuck / inventory_full / 任务卡死
    this.unsubs.push(
      this.bus.onLevel('recoverable', ev => this.onEvent(ev)),
    );
    // task.resumed（包括子任务完成/失败后 TaskRuntime 自动恢复父任务的场景）
    // 重置 lastProgressTick 避免 resume 后立即被 watchdog 判为 stuck
    this.unsubs.push(
      this.bus.on('task.resumed', ev => {
        const taskId = (ev.payload as { taskId?: string })?.taskId;
        if (taskId) {
          this.state.lastProgressTick.delete(taskId);
          this.state.recoveryAttempts.delete(taskId);
        }
      }),
    );
    // 自定义：danger_cleared（外部由其它模块或 atomic 在反击成功后发）
    this.unsubs.push(
      this.bus.on('danger_cleared', ev => this.onEvent(ev)),
    );
    // 自定义：atomic.attack 成功后 emit · 用来推断 danger_cleared（最简化）
    this.unsubs.push(
      this.bus.on('atomic.attack', () => {
        // 简化版：每次反击都尝试触发"危险解除"判断
        // 真实实现应当看 hostile 还在不在视野
        setTimeout(() => this.tryClearDanger(), 300);
      }),
    );
  }

  private onEvent(ev: BusEvent): void {
    const allTasks = this.tasks.list();
    const supervisedTasks = allTasks.filter(task => !isProjectionTask(task));
    const actions = decide(
      { kind: 'event', event: ev },
      this.state,
      this.perception.getWorldState(),
      this.cfg,
      {
        running: supervisedTasks.filter(t => t.state === 'running'),
        paused: supervisedTasks.filter(t => t.state === 'paused'),
      },
    );
    commit(actions, this.state, {
      tasks: this.tasks,
      narration: this.narration,
      bus: this.bus,
      injector: this.injector,
    });
  }

  private tryClearDanger(): void {
    // 看 WorldState 里附近 16 格内还有没有 hostile · 没有才算解除
    const world = this.perception.getWorldState();
    if (!world) return;
    const stillThreat = world.entities.some(
      e => e.category === 'hostile' && e.distance <= this.cfg.HOSTILE_CLEAR_RANGE,
    );
    if (stillThreat) return;
    if (this.state.suspendedByDanger.size === 0) return;
    this.bus.publish('danger_cleared', 'info', {
      reason: 'no_hostile_in_range',
    });
  }
}
