/**
 * 💓 基础设施 #2 · Heartbeat 心跳调度（v2 · 10 步主循环）
 *
 * 每 200ms 一个 tick · 10 步严格顺序：
 *   ① Perceive       · perception.perceive()
 *   ② DrainEvents    · bus.drain() + 喂给 Reflex
 *   ③ Watchdog       · supervisor.watchdog(tick)
 *   ④ Reflex         · L5 ReflexStrategy.tick() → ActionRequest[]
 *   ⑤ TaskSched      · L6 sched 推进 + 输出当前 active task
 *   ⑥ StrategyTick   · L5 任务驱动策略.tick() → ActionRequest[]
 *   ⑦ Arbitrate ★    · ActionArbitrator.arbitrate(requests) → winner
 *   ⑧ Execute        · BodyActionService → BodyExecutionRuntime → Receipt
 *   ⑨ Critic / Emit  · 评测 + 广播 task.tick_done
 *   ⑩ MemoryCommit   · memory.commitTick()
 *
 * 注意：⑧ 是异步的（pathfinder/attack 可能耗时），用 AsyncTaskQueue 跑后台。
 * 但同 tick 内只发起 / 监控一个 winner，下一 tick 再决议（避免 tick 重入）。
 */

import type { EventBusV2 } from './eventBus.js';
import type { MemoryV2 } from './memory.js';
import type { PerceptionPipeline } from '../perception/pipeline.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import type { RuntimeSupervisor } from '../decision/supervisor.js';
import type { ReflexStrategy } from '../strategy/reflexStrategy.js';
import type { IStrategy, StrategyContext } from '../strategy/types.js';
import type { ActionRequest, ArbitrationResult, WorldStateView } from '../types.js';
import type { BodyActionService } from '../task/execution/bodyActionService.js';
import type { AsyncTaskQueue } from './asyncTaskQueue.js';
import { TickRate, type TickRegistry, type TickContext } from './tickRegistry.js';
import type { ICriticRegistry } from '../task/critic/types.js';

export interface HeartbeatConfig {
  tickMs: number;
  /** 是否在 ⑧ Execute 时阻塞等 atomic 完（true）还是 fire-and-forget 多 tick 推进（false） */
  blockingExecute: boolean;
}

export interface HeartbeatDeps {
  bus: EventBusV2;
  memory: MemoryV2;
  perception: PerceptionPipeline;
  tasks: TaskRuntime;
  supervisor: RuntimeSupervisor;
  reflex: ReflexStrategy;
  /** 所有任务驱动策略 · Heartbeat 在 ⑥ StrategyTick 时按 isActive 过滤 + tick */
  taskStrategies: IStrategy[];
  /** 自动防御策略（当前为 Survival）；与普通任务策略分开门控。 */
  autoDefenseStrategies?: IStrategy[];
  /** 生产调参热开关；未提供时保持兼容并视为开启。 */
  isAutomaticDefenseEnabled?: () => boolean;
  body: BodyActionService;
  /** 可选 · AsyncTaskQueue · ② DrainEvents 时消费已完成结果 */
  asyncQueue?: AsyncTaskQueue;
  /** 可选 · TickRegistry · ④ 节拍分发时按 rate 触发注册模块 */
  tickRegistry?: TickRegistry;
  /** 可选 · ICriticRegistry · ⑨ Critic 每 SLOW tick 评测 running 任务 · success → tasks.complete */
  critic?: ICriticRegistry;
  /** FEAT-CROSS-08 / BUG-CROSS-25 · 每 tick 现读游戏身体态，陪聊态只运行安全子循环。 */
  isEmbodied: () => boolean;
}

export class Heartbeat {
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private arbitrator = new ActionArbitrator();
  /** FEAT-NARR-01 · 统一语言中枢 · 每 tick flushTick 一次（在 ⑦ Arbitrate 前）*/
  private narration: { flushTick(): void; narrate(intent: import('../narration/types.js').SpeechIntent): void } | null = null;
  /** 由外部模块（如 Supervisor）注入的 ActionRequest 队列 · 下 tick 一起仲裁 */
  private externalRequests: ActionRequest[] = [];
  /** ⑨ Critic 用：上一 SLOW tick 末的世界快照（作为下一次评测的 before）*/
  private criticSnapshot: WorldStateView | null = null;
  private automaticDefenseEnabled: boolean | null = null;

  /** 外部模块（Supervisor / 其他）可调 · 提交一个 ActionRequest 进入下 tick 仲裁 */
  submitRequest(req: ActionRequest): void {
    this.externalRequests.push(req);
  }

  /** 兼容入口：外部模块只能报告发言请求，由 MainBrain 决定是否说。 */
  submitSay(source: string, text: string, priority = 50): void {
    this.deps.bus.publish('brain.notice', 'suggestion', {
      source,
      topic: 'speech_request',
      label: '外部模块请求发言',
      detail: text,
      status: 'info',
      wake: priority >= 60,
      dedupeKey: `speech_request:${source}:${text}`,
    });
  }

  /**
   * 确定性撤销游戏身体动作，供离身、主人取消和 Benchmark case 复位使用。
   * 保留 say/stop 轻请求，避免取消身体时误伤已经排队的聊天输出。
   */
  cancelBodyActions(): number {
    const before = this.externalRequests.length;
    this.externalRequests = this.externalRequests.filter(req => isLightAction(req.type));

    this.deps.body.cancelAll('heartbeat_cancel');
    return before - this.externalRequests.length;
  }

  constructor(
    private readonly cfg: HeartbeatConfig,
    private readonly deps: HeartbeatDeps,
  ) {}

  /** FEAT-NARR-01 · v2Runtime 装配末尾注入统一语言中枢 */
  attachNarration(n: { flushTick(): void; narrate(intent: import('../narration/types.js').SpeechIntent): void }): void {
    this.narration = n;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─────────────── tick 主体 ───────────────

  private async runTick(): Promise<void> {
    this.tick += 1;
    const { bus, memory, perception, tasks, supervisor, reflex, taskStrategies, autoDefenseStrategies, body } = this.deps;
    const automaticDefenseEnabled = this.deps.isAutomaticDefenseEnabled?.() ?? true;
    if (this.automaticDefenseEnabled !== automaticDefenseEnabled) {
      const wasEnabled = this.automaticDefenseEnabled;
      this.automaticDefenseEnabled = automaticDefenseEnabled;
      if (!automaticDefenseEnabled) {
        reflex.suspend?.();
        for (const strategy of autoDefenseStrategies ?? []) strategy.suspend?.();
        this.cancelBodyActions();
      }
      bus.publish('defense.mode_changed', 'info', {
        enabled: automaticDefenseEnabled,
        previous: wasEnabled,
        resetPendingEvents: !automaticDefenseEnabled,
      });
    }
    const embodied = this.deps.isEmbodied();

    // BUG-CROSS-36 · 陪聊态不空跑游戏 10 步循环。仍以短 tick drain/commit，
    // 保证真实聊天事件及时落盘；只在 IDLE 节拍唤醒主动关怀判断。
    if (!embodied) {
      await this.runCompanionTick();
      return;
    }

    // BUG-L5-03 诊断 · 分阶段计时，定位同步阻塞事件循环 ~10s 的元凶
    const T0 = Date.now();
    let tPerceive = 0, tReflex = 0, tRegistry = 0, tSched = 0, tStrat = 0, tExec = 0;
    const since = (m: number) => Date.now() - m;

    try {
      // ① Perceive
      let _m = Date.now();
      const world = perception.perceive();
      tPerceive = since(_m);

      // ② DrainEvents
      const events = bus.drain();
      if (embodied && automaticDefenseEnabled) reflex.ingestCritical(events);
      // 消费 AsyncTaskQueue 已完成的结果（LLM turn 等）· 结果已在 .then 里发布事件
      if (this.deps.asyncQueue) {
        const asyncResults = this.deps.asyncQueue.drainResults();
        for (const r of asyncResults) {
          if (r.error !== undefined) {
            bus.publish('llm.turn_error', 'recoverable', { error: r.error });
          }
        }
      }
      // 这一 tick 看到的 owner_in_range 可以用来推 follow 完成（最简化版略过）

      // ③ Watchdog（Supervisor 收拢）
      if (embodied) supervisor.watchdog(this.tick);

      // ⑤ 先推进 TaskSched 拿到 active task，再做 ④ Reflex tick 的 ctx（顺序无紧耦合）
      // —— 但按规范严格 ④→⑤，先 reflex
      const activeTask = tasks.active();
      const ctx: StrategyContext = {
        world,
        tick: this.tick,
        activeTaskId: activeTask?.id ?? null,
        activeTaskKind: activeTask?.kind ?? null,
        activeTaskParams: activeTask?.params ?? null,
        narrate: (i) => this.narration?.narrate(i), // FEAT-NARR-01 · 策略经此上报中性通知
        // FEAT-WEBUI-08 · 策略写当前任务的人话动作（NPC 行为展示）· 仅改 progress.phase 不影响执行
        setPhase: (text: string) => {
          if (activeTask) activeTask.progress = { ...(activeTask.progress ?? {}), phase: text };
        },
      };

      // ④ Reflex
      _m = Date.now();
      const reflexRequests = embodied && automaticDefenseEnabled ? reflex.tick(ctx) : [];
      tReflex = since(_m);

      // ④.5 TickRegistry · 按节拍等级分发注册模块（WorldMapCollector / WorldScan 等在此）
      _m = Date.now();
      if (this.deps.tickRegistry) {
        this.dispatchTickRegistry(world);
      }
      tRegistry = since(_m);

      // ⑤ TaskSched · 推进
      _m = Date.now();
      if (embodied) tasks.sched(this.tick, world);
      tSched = since(_m);

      // ⑥ StrategyTick · 任务驱动策略（按 active 过滤）
      _m = Date.now();
      const taskRequests: ActionRequest[] = [];
      // BUG-CROSS-28：重动作执行期不为必然被 busy 拒绝的请求做昂贵规划。
      // Reflex 已在上一步运行，紧急 hard 抢占不受影响；任务 Strategy 在动作结束后的下一 tick 恢复。
      const safetyOrigins = new Map<ActionRequest,string>(reflexRequests.map(request=>[request,'reflex']));
      if (embodied) {
        const strategies = automaticDefenseEnabled
          ? [...(autoDefenseStrategies ?? []), ...taskStrategies]
          : taskStrategies;
        for (const s of strategies) {
          if (!body.busy() && s.isActive(ctx) || (automaticDefenseEnabled && autoDefenseStrategies?.includes(s) && s.isActive(ctx))) {
            const rs = s.tick(ctx);
            // FEAT-CROSS-05 · 任务驱动策略的请求自动用当前 active task 背书（reflex 类自带 taskId 不覆盖）
            if (autoDefenseStrategies?.includes(s)) for (const r of rs) safetyOrigins.set(r,'automatic-defense');
            else for (const r of rs) if (r.taskId == null && ctx.activeTaskId) r.taskId = ctx.activeTaskId;
            taskRequests.push(...rs);
          }
        }
      }
      tStrat = since(_m);

      // 把任务上下文写回 world（task_context view）
      world.taskContext = {
        currentTaskId: ctx.activeTaskId,
        currentTaskKind: ctx.activeTaskKind,
        currentTaskState: activeTask?.state ?? null,
      };

      // ⑥.9 Narration · 把本 tick 上报的事件通知意图收敛成至多一句中性通知（入 externalRequests 参与仲裁）
      this.narration?.flushTick();

      // ⑦ Arbitrate ★
      const externalReq = this.externalRequests;
      this.externalRequests = [];
      const allReq = [...reflexRequests, ...taskRequests, ...externalReq];

      // FEAT-CROSS-05 / BUG-CROSS-04 · task 背书硬门：任务树是执行权唯一真相。
      // 只有当前 running task 才能占 movement；无 task、未知、paused、terminal 请求均在仲裁前剔除。
      const authorizedReq = allReq.filter(r => {
        if (!embodied) {
          if (r.type === 'say' || r.type === 'stop') return true;
          bus.publish('arbiter.body_unavailable', 'recoverable', {
            source: r.source, type: r.type, taskId: r.taskId ?? null, tick: this.tick,
            rejected: true,
          });
          return false;
        }
        if (safetyOrigins.has(r) || isLightAction(r.type)) return true;
        if (r.taskId && tasks.isRunning(r.taskId)) return true;
        bus.publish('arbiter.orphan_request', 'recoverable', {
          source: r.source, type: r.type, taskId: r.taskId ?? null, tick: this.tick,
          rejected: true,
        });
        return false;
      });

      const arb = this.arbitrator.arbitrate(authorizedReq, world, body.busy(), body.currentRequest());
      this.publishArbitration(bus, arb);

      // The body runtime is the only busy/timeout/preemption authority.
      // Dispatch producers carry their trusted origin separately from request.source.
      for (const request of arb.winners) {
        const work = this.runExecute(request,safetyOrigins.get(request));
        if (this.cfg.blockingExecute) await work;
        else void work;
      }

      // ⑨ Critic / Emit · 每 SLOW tick（10 tick）调 critic.verifyAll → success 的 complete
      if (embodied && this.deps.critic && this.tick % TickRate.SLOW === 0) {
        const runningTasks = this.deps.tasks.list().filter(t => t.state === 'running');
        if (runningTasks.length > 0) {
          // before = 上一 SLOW 窗口末的快照；首次评测 fallback 当前快照
          const before = this.criticSnapshot ?? world;
          const verdicts = this.deps.critic.verifyAll(runningTasks, before, world);
          for (const v of verdicts) {
            bus.publish('critic.verdict', 'info', {
              taskId: v.taskId,
              taskKind: v.taskKind,
              status: v.status,
              reason: v.reason,
            });
            if (v.status === 'success') {
              this.deps.tasks.complete(v.taskId);
            }
          }
        }
        // 滚动快照：本 tick 的 world 成为下次评测的 before
        this.criticSnapshot = world;
      }
      bus.publish('heartbeat.tick_done', 'info', {
        tick: this.tick,
        embodied,
        winners: arb.winners.map(w => `${w.source}/${w.type}`),
        ownerDist: world.owner?.distance ?? null,
      });

      // ⑩ MemoryCommit
      const committed = memory.commitTick();
      if (committed > 0) {
        bus.publish('memory.commit', 'info', { tick: this.tick, count: committed });
      }

      // BUG-L5-03 诊断 · 整 tick 同步耗时 > 800ms 时打分阶段明细，钉死阻塞元凶
      const total = since(T0);
      if (total > 800) {
        console.log(
          `[TICK-SLOW ${new Date().toISOString().slice(11, 23)}] total=${total}ms ` +
          `perceive=${tPerceive} reflex=${tReflex} registry=${tRegistry} sched=${tSched} strat=${tStrat} exec=${tExec}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bus.publish('heartbeat.tick_error', 'recoverable', { tick: this.tick, error: msg });
      console.error('[heartbeat] tick error:', e);
    }
  }

  private async runCompanionTick(): Promise<void> {
    const { bus, memory } = this.deps;
    bus.drain();

    if (this.deps.asyncQueue) {
      for (const result of this.deps.asyncQueue.drainResults()) {
        if (result.error !== undefined) bus.publish('llm.turn_error', 'recoverable', { error: result.error });
      }
    }

    if (this.tick % TickRate.IDLE === 0) {
      bus.publish('heartbeat.rate_tick', 'info', { rate: TickRate.IDLE, tick: this.tick });
    }

    this.narration?.flushTick();
    const requests = this.externalRequests;
    this.externalRequests = [];
    for (const request of requests) {
      if (!isLightAction(request.type)) {
        bus.publish('arbiter.body_unavailable', 'recoverable', {
          source: request.source,
          type: request.type,
          taskId: request.taskId ?? null,
          tick: this.tick,
          rejected: true,
        });
        continue;
      }
      if (this.cfg.blockingExecute) await this.runExecute(request);
      else void this.runExecute(request);
    }

    const committed = memory.commitTick();
    if (committed > 0) bus.publish('memory.commit', 'info', { tick: this.tick, count: committed });
  }

  private async runExecute(
    req: ActionRequest,
    safetyPolicy?: string,
  ): Promise<void> {
    const start = Date.now();
    const result = safetyPolicy
      ? await this.deps.body.executeSafety(req,safetyPolicy)
      : await this.deps.body.executeTask(req);
    const elapsedMs = Date.now() - start;
    this.deps.bus.publish(result.ok ? 'exec.success' : 'exec.fail', 'info', {
      source: req.source,
      type: req.type,
      durationMs: elapsedMs,
      error: result.error,
    });
    // 给 Supervisor 的 stuck 检测留印
    if (
      result.ok &&
      (req.type === 'move_to' || req.type === 'follow_entity')
    ) {
      this.deps.memory.setRuntime('last_move_ok_tick', this.tick);
    }
  }

  /**
   * 按四级节拍分发 TickRegistry 中的已注册模块
   * FAST(1) 每 tick · STD(5) 每 5 tick · SLOW(10) 每 10 tick · IDLE(150) 每 150 tick
   */
  private dispatchTickRegistry(world: WorldStateView): void {
    const registry = this.deps.tickRegistry!;
    const bus = this.deps.bus;
    const rates: TickRate[] = [TickRate.FAST, TickRate.STD, TickRate.SLOW, TickRate.IDLE];

    for (const rate of rates) {
      if (this.tick % rate !== 0) continue;
      const ctx: TickContext = { tick: this.tick, rate, world };
      bus.publish('heartbeat.rate_tick', 'info', { rate, tick: this.tick });
      for (const tickable of registry.getByRate(rate)) {
        try {
          tickable.onTick(ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          bus.publish('heartbeat.tick_error', 'recoverable', {
            tick: this.tick,
            error: `[tickRegistry:${tickable.id}] ${msg}`,
          });
        }
      }
    }
  }

  private publishArbitration(bus: EventBusV2, arb: ArbitrationResult): void {
    if (arb.winners.length > 0 || arb.rejected.length > 0) {
      bus.publish('arbitrate.result', 'info', {
        winners: arb.winners.map(w => ({
          source: w.source,
          type: w.type,
          priority: w.priority,
        })),
        rejected: arb.rejected.map(r => ({
          source: r.request.source,
          type: r.request.type,
          priority: r.request.priority,
          reason: r.reason,
        })),
      });
    }
  }
}

/** say / stop 等不占游戏控制资源的"轻动作"，跟正在跑的 move/attack 可以并行 */
function isLightAction(t: ActionRequest['type']): boolean {
  return t === 'say' || t === 'stop';
}

// ────────────────────────────────────────────────────────────────────
// ⑦ Arbitrate · ActionArbitrator
// ────────────────────────────────────────────────────────────────────

export class ActionArbitrator {
  /**
   * 仲裁 4 步：预检 → 排序 → 冲突 → 下发
   * 多胜出：资源不冲突的可以并行通过（典型如 attack 跟 say 同 tick）
   */
  arbitrate(
    requests: ActionRequest[],
    world: WorldStateView,
    executing: boolean,
    currentReq: ActionRequest | null,
  ): ArbitrationResult {
    if (requests.length === 0) {
      return { winners: [], rejected: [] };
    }

    // 1. 预检 preconditions
    const passed: ActionRequest[] = [];
    const rejected: ArbitrationResult['rejected'] = [];
    for (const r of requests) {
      const missing = checkPreconditions(r, world);
      if (missing.length === 0) {
        passed.push(r);
      } else {
        rejected.push({ request: r, reason: `precondition_missing:${missing.join(',')}` });
      }
    }

    // 2. 按 priority 降序
    passed.sort((a, b) => b.priority - a.priority);

    // 3. 冲突解析（可多胜出）
    const winners: ActionRequest[] = [];
    const usedResources = new Set<string>();

    for (const r of passed) {
      // 如果 currentReq 正在跑（占用 game 主控）：
      if (executing && currentReq) {
        if (r.interrupt_level === 'hard' && r.priority > currentReq.priority) {
          // hard 抢占：当前 tick 让 r 上 · 同时把 currentReq 占用的资源标记为已抢占
          winners.push(r);
          for (const res of r.resource) usedResources.add(res);
          continue;
        }
        // 不能抢占的重活直接 reject；轻动作（say/stop）仍可并行
        if (r.resource.length === 0) {
          winners.push(r);
          continue;
        }
        rejected.push({ request: r, reason: `busy:current=${currentReq.source}` });
        continue;
      }
      // 资源冲突？
      const conflict = r.resource.some(res => usedResources.has(res));
      if (conflict) {
        rejected.push({ request: r, reason: 'resource_conflict' });
        continue;
      }
      winners.push(r);
      for (const res of r.resource) usedResources.add(res);
    }

    return { winners, rejected };
  }
}

function checkPreconditions(r: ActionRequest, world: WorldStateView): string[] {
  const missing: string[] = [];
  for (const p of r.preconditions) {
    if (p === 'owner_visible' && !world.owner?.isVisible) missing.push(p);
    if (p === 'owner_known' && !world.owner) missing.push(p);
    // 后续：has_hoe / is_near_target / not_under_attack ...
  }
  return missing;
}
