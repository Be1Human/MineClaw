/**
 * 🧠 L7 · MainBrain（v2 · 编排器）
 *
 * 职责精简：
 *   1. 订阅 chat.from_owner → 触发 turn
 *   2. 串行化 turn（busy 锁）
 *   3. LLM 维持人格与高层意图；游戏内容只经 GoalAgentPort
 *   4. 维护 pendingAskMaster 历史 · 玩家答复时恢复
 *
 * 实际 dispatch / 系统提示词 / 循环逻辑都拆到独立文件：
 *   - tools/        · ToolRegistry + 工具定义（FEAT-L7-13 注册式，取代 dispatcher.ts）
 *   - llmLoop.ts    · LLMToolLoop
 *   - systemPrompt.ts
 */

import type { LLMClient } from '../cognitive/llm/LLMClient.js';
import {
  LLMToolLoop,
  restoreMainBrainPendingHistory,
  serializeMainBrainPendingHistory,
  type HistoryEntry,
} from './llmLoop.js';
import { buildMainBrainToolRegistry, type MainBrainToolDeps, type ToolRegistry } from './tools/index.js';
import { buildMainBrainSystemPrompt, formatConversationHistory, sanitizeRoleContext } from './systemPrompt.js';
import { tuning } from '../infra/tuning.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import { detectAddress } from '../cognitive/addressDetector.js';
import type { AsyncTaskQueue } from '../infra/asyncTaskQueue.js';
import { TickRate } from '../infra/tickRegistry.js';
import type { MemoryV2, ConversationEntry } from '../infra/memory.js';
import type { CompanionCore } from '../companion/companionCore.js';
import type { ChatMemoryService } from '../infra/chatMemory.js';
import type { CharacterCardV1 } from '../../../character/types.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import { BrainSpeechGateway } from './brainSpeechGateway.js';
import { BrainNoticeInbox, type BrainNotice, type BrainNoticeInput } from './brainNoticeInbox.js';
import type { GoalContinuationV2 } from './goalAgentPort/contracts.js';
import { GoalReportSpeechPolicy } from './goalAgentPort/goalReportSpeechPolicy.js';
import { buildMainBrainContext } from './agentContext.js';
import { MainBrainLoopCritic } from './loopCritic.js';
import type { LlmTraceRecorderPort } from '../infra/llmTrace/index.js';
import { isTaskCancellationRequest, stripTaskCancellationPrefix } from './ownerControlIntent.js';
import {
  buildGamePresenceContext,
  type GamePresenceState,
} from '../gamePresenceContext.js';

export { isTaskCancellationRequest, stripTaskCancellationPrefix } from './ownerControlIntent.js';

/** FEAT-L7-16 · turn 触发来源（决定角色通道：owner 记 conversation，其余只记 bot 产出） */
export type TurnKind = 'owner' | 'idle' | 'task_feedback' | 'goal_continuation';

export interface MainBrainConfig {
  ownerName: string;
  botName?: string;
  persona?: string;
  characterCard?: CharacterCardV1;
  characterPrompt?: (message: string) => string;
  /** LLM 模式下单 turn 最多调几轮工具 · 默认 8 */
  maxRounds?: number;
  /** 是否启用 IDLE 节拍主动找事做 · 默认 true */
  idleEnabled?: boolean;
  /** 信息性字段 · IDLE 触发频率毫秒（实际由 TickRate.IDLE 控制）· 默认 30000 */
  idleFreqMs?: number;
  /** 是否把任务终态回执重新喂给 MainBrain 决策 · 默认 true；隔离评测可关闭 */
  taskFeedbackEnabled?: boolean;
  onLog?: (msg: string) => void;
}

export interface MainBrainDeps extends MainBrainToolDeps {
  /** MainBrain 只用它对外说话，不通过它读取或操作游戏世界。 */
  game: GameAdapter;
  embodied?: boolean;
  isEmbodied?: () => boolean;
  getGamePresence?: () => GamePresenceState;
  /** FEAT-CROSS-04：在 AddressDetector 之前截获的 TestBench 命令处理器。 */
  onBenchCommand?: (message: string) => boolean;
  /** FEAT-CROSS-04：运行测试卡时禁止 IDLE/主动决策向同一执行链插入额外行为。 */
  isBenchActive?: () => boolean;
  /** BUG-CROSS-16：主人明确停止/改派时，在 LLM 前确定性取消旧执行链。 */
  onOwnerCancellation?: (message: string) => number;
  /** 可选 · 不传则走 rule-based 模式 */
  llm?: LLMClient | null;
  /** 可选 · 传入后 LLM turn 异步化 · 不再阻塞 tick 主循环 */
  asyncQueue?: AsyncTaskQueue;
  /** 可选 · 获取当前 running 任务数 · 用于 IDLE 空转冷却判断 */
  getRunningTaskCount?: () => number;
  /** 可选 · 传入后启用对话历史持久化 */
  memory?: MemoryV2;
  /** FEAT-NARR-01 · 统一语言中枢 · 提供近期事件通知，每 turn 注入 LLM 上下文 */
  narration?: { recentNotices(): string };
  /** FEAT-CROSS-09 · 独立陪伴核心，只提供受治理的 Prompt 上下文。 */
  companion?: CompanionCore;
  /** FEAT-MEM-09 · Profile 隔离的纯聊天记忆生命周期服务。 */
  chatMemory?: ChatMemoryService;
  /** FEAT-WEBUI-19：与 LLMClient 共用的 Profile 轨迹事实源。 */
  llmTraceRecorder?: LlmTraceRecorderPort;
  /** FEAT-CROSS-25 · 与 GoalAgent 共用的主动能力只读快照。 */
  getProactiveCapabilitiesContext?: () => string;
}

export class MainBrain {
  /** BUG-CROSS-32 · Runtime stop 后旧 MainBrain 永久失效，禁止迟到推理产生副作用。 */
  private closed = false;
  /** MainBrain 自己注册的总线订阅，shutdown 时统一解除。 */
  private unsubs: Array<() => void> = [];
  /**
   * 当前占锁者：null=空闲 · 'idle'=IDLE主动turn · 'owner'=主人驱动turn · 'task_feedback'=任务终态回执turn。
   * 拆来源是为了让主人消息能抢占 IDLE（主人 > 任务反馈 > IDLE，铁律）。
   */
  private busyBy: TurnKind | null = null;
  /** FEAT-L7-16 · 任务终态回执队列（去抖窗口内合并成一次 task_feedback turn） */
  private readonly noticeInbox = new BrainNoticeInbox();
  /** Legacy test/debug view; production code writes only through noticeInbox.submit(). */
  private get taskFeedbackQueue(): BrainNotice[] { return this.noticeInbox.peek(); }
  /** FEAT-L7-16 · 去抖/重试定时器句柄 */
  private taskFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** 玩家游戏任务专用续接队列；不得压成无关联的 task_feedback。 */
  private readonly goalContinuations: GoalContinuationV2[] = [];
  private readonly goalReportSpeechPolicy = new GoalReportSpeechPolicy();
  private readonly continuationKeys = new Set<string>();
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  /** FEAT-CROSS-09 · 有界 FIFO：已接收的主人消息绝不静默覆盖。 */
  private pendingOwnerMsgs: Array<{ message: string; skipAddressCheck: boolean }> = [];
  private static readonly OWNER_QUEUE_MAX = 100;
  /** IDLE turn 是否已被主人消息抢占 · true → turn 结束后丢弃结果 */
  private idleTurnAborted = false;
  /** IDLE turn 的 AbortController · owner 消息到来时立即 abort LLM 请求 */
  private idleAbortController: AbortController | null = null;
  /** BUG-CROSS-19 · 当前 owner/task_feedback turn 的抢占控制器。 */
  private activeTurnAbortController: AbortController | null = null;
  /** 主人取消后禁止 IDLE 用旧状态自行复活；下一条有效主人消息解除。 */
  private idleSuppressedByCancellation = false;
  /** IDLE 冷却截止时间 ms · 0 = 不在冷却 */
  private idleCooldownUntil = 0;
  /** IDLE 空转冷却时长（纯 say/ask_master 后触发） */
  private static readonly IDLE_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟
  /** FEAT-L7-04：网络瞬断短冷却（避免 Connection error 进 5 分钟黑屏） */
  private static readonly IDLE_NET_ERROR_COOLDOWN_MS = 90 * 1000; // 90s
  /** FEAT-L7-04：本次 turn 是否因网络瞬断要走短冷却（runtime 标志） */
  private idleShortCooldownPending = false;
  /** FEAT-L7-04：最近 bus 事件环形缓冲（IDLE prompt 注入用） */
  private recentEventsRing: Array<{ type: string; summary: string; ts: number }> = [];
  private static readonly RECENT_RING_MAX = 50;
  /** IDLE prompt 关心的事件类型白名单 */
  private static readonly IDLE_EVENT_WHITELIST = new Set([
    'chat.from_owner', 'goalagent.report', 'goalagent.notification',
  ]);

  /** ask_master 后保存的历史 · 用于答复后恢复 LLM context */
  private pendingHistory: HistoryEntry[] | null = null;
  /** Durable conversation row that owns pendingHistory. */
  private pendingConversation: ConversationEntry | null = null;

  private readonly toolRegistry: ToolRegistry;
  private readonly llmLoop: LLMToolLoop | null;
  private readonly bus: EventBusV2;
  private readonly asyncQueue: AsyncTaskQueue | null;
  private readonly getRunningTaskCount: (() => number) | null;
  private readonly companion: CompanionCore | null;
  private readonly chatMemory: ChatMemoryService | null;
  private readonly onBenchCommand: ((message: string) => boolean) | null;
  private readonly isBenchActive: () => boolean;
  private readonly onOwnerCancellation: ((message: string) => number) | null;
  private readonly memory: MemoryV2 | null;
  private readonly goalAgentPort: MainBrainDeps['goalAgentPort'];
  private readonly llmTraceRecorder: LlmTraceRecorderPort | null;
  /** FEAT-L6-04：本轮 IDLE 检测到的连败 escalate（_fireIdleTriggers 置位 · spawnIdleTurn 消费）*/
  private pendingEscalate: { triggerId: string; reason: string; count: number } | null = null;
  /** BUG-CROSS-01 修④：徒劳任务标记（v2Runtime futility_watch 置位 · spawnIdleTurn 消费）。
   *  存在时不再因"有活跃任务"跳过 IDLE——卡死任务不该压制大脑巡逻。 */
  private futileTask: { taskId: string; kind: string; stalledMs: number } | null = null;
  /** 徒劳 escalate 冷却截止（防同一卡死任务反复唤醒刷屏） */
  private futileEscalateCooldownUntil = 0;
  /** FEAT-CROSS-08 v2 · 运行时现读身体态（热插拔）· 无身体=日常陪聊态。 */
  private readonly isEmbodied: () => boolean;
  private readonly getGamePresence: () => GamePresenceState;
  private readonly speechGateway: BrainSpeechGateway;
  private turnSeq = 0;
  /** 当前进程内的连续聊天会话；turnId 只用于请求追踪，不能用作摘要会话边界。 */
  private readonly chatSessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    deps: MainBrainDeps,
    private readonly cfg: MainBrainConfig,
  ) {
    this.bus = deps.bus;
    this.asyncQueue = deps.asyncQueue ?? null;
    this.getRunningTaskCount = deps.getRunningTaskCount ?? null;
    this.memory = deps.memory ?? null;
    this.companion = deps.companion ?? null;
    this.chatMemory = deps.chatMemory ?? null;
    this.onBenchCommand = deps.onBenchCommand ?? null;
    this.isBenchActive = deps.isBenchActive ?? (() => false);
    this.onOwnerCancellation = deps.onOwnerCancellation ?? null;
    this.goalAgentPort = deps.goalAgentPort;
    this.llmTraceRecorder = deps.llmTraceRecorder ?? null;
    this.isEmbodied = deps.isEmbodied ?? (() => deps.embodied !== false);
    this.getGamePresence = deps.getGamePresence
      ?? (() => ({ embodied: this.isEmbodied(), ownerObservation: 'unknown' }));
    this.speechGateway = new BrainSpeechGateway(this.bus, deps.game, this.isEmbodied);
    this.toolRegistry = buildMainBrainToolRegistry(deps, {
      speak: (text, mode) => { this.speechGateway.commit(text, mode); },
    });

    // 无 LLM 时只明确失败，不恢复旧 RuleLoop 游戏旁路。
    if (deps.llm) {
      // 热刷新：记忆/对话历史改为每 turn 注入（见下方 cfg.memoryBlock/conversationBlock），
      // base prompt 只含静态角色/技能索引 —— 修"存了记忆要重启才引用"+"对话前言不搭后语"。
      const promptParams = {
        ownerName: cfg.ownerName,
        botName: cfg.botName ?? 'MineFriend',
        persona: cfg.persona,
        characterCardMode: !!cfg.characterCard,
      };
      const systemPrompt = buildMainBrainSystemPrompt(promptParams);
      this.llmLoop = new LLMToolLoop(
        deps.llm,
        this.toolRegistry,
        {
          systemPrompt,
          maxRounds: cfg.maxRounds ?? 8,
          bus: this.bus,
          characterBlock: cfg.characterPrompt,
          runtimeBlock: () => [
            buildGamePresenceContext(this.getGamePresence()),
            deps.getProactiveCapabilitiesContext?.().trim() ?? '',
          ].filter(Boolean).join('\n'),
          minecraftEnabled: cfg.characterCard?.performance.capabilities.minecraft ?? true,
          memoryEnabled: cfg.characterCard?.performance.capabilities.memory ?? true,
          recentNotices: deps.narration ? () => deps.narration!.recentNotices() : undefined,
          memoryBlock: cfg.characterCard?.performance.capabilities.memory === false
            ? undefined
            : (deps.botMemory || deps.chatMemory)
              ? (currentMessage) => sanitizeRoleContext([
                deps.botMemory?.load(cfg.ownerName) ?? '',
                deps.chatMemory?.toPromptContext(currentMessage) ?? '',
              ].filter(Boolean).join('\n\n'), this.isEmbodied())
              : undefined,
          conversationBlock: this.memory ? () => sanitizeRoleContext(
            formatConversationHistory(this.memory!.query('conversation') as ConversationEntry[]),
            this.isEmbodied(),
          ) : undefined,
          companionBlock: deps.companion ? () => deps.companion!.toPromptContext() : undefined,
          loopCritic: new MainBrainLoopCritic(),
          traceRecorder: this.llmTraceRecorder ?? undefined,
        },
        m => this.log(m),
      );
      this.log('LLM 模式启用 · MainBrain 受限人格/聊天 + GoalAgentPort');
    } else {
      this.llmLoop = null;
      this.log('LLM 未配置 · MainBrain 不启用旧 RuleLoop 游戏降级');
    }

    this.unsubs.push(this.bus.on('chat.from_owner', ev => {
      const payload = ev.payload as { sender: string; message: string };
      void this.tryHandle(payload.message);
    }));

    // 启动时恢复 ask_master pendingHistory（跨重启恢复）
    if (this.memory) {
      const pendingEntries = this.memory.query('conversation', { isPending: true }) as ConversationEntry[];
      const latestPending = pendingEntries.at(-1);
      const pendingFresh = latestPending && Date.now() - latestPending.timestamp <= 15 * 60_000;
      if (pendingFresh) {
        this.log(`恢复有效 ask_master 挂起状态 · turn=${latestPending.turnId}`);
        const restored = restoreMainBrainPendingHistory(latestPending.meta?.llmContinuation);
        this.pendingHistory = restored ?? [];
        this.pendingConversation = latestPending;
        this.log(restored
          ? `已恢复 ${restored.length} 条 MainBrain 工具/replay 历史`
          : '挂起记录没有可用 continuation envelope，将使用对话文本安全恢复');
      } else if (pendingEntries.length > 0) {
        this.log(`忽略 ${pendingEntries.length} 条过期 ask_master 历史`);
      }
    }

    // 订阅 IDLE 节拍 · 每 150 tick（~30s）触发一次主动找事做
    this.unsubs.push(this.bus.on('heartbeat.rate_tick', ev => {
      const payload = ev.payload as { rate: number; tick: number };
      if (payload.rate !== TickRate.IDLE) return;
      if (this.cfg.idleEnabled === false) return;
      if (this.busyBy === null) {
        void this.spawnIdleTurn();
      }
    }));

    // FEAT-L7-04：收集近期事件（白名单类型），IDLE prompt 注入用
    this.unsubs.push(this.bus.onAny(ev => {
      if (!MainBrain.IDLE_EVENT_WHITELIST.has(ev.type)) return;
      this.recentEventsRing.push({
        type: ev.type,
        summary: this._summarizeEvent(ev.type, ev.payload),
        ts: ev.timestamp,
      });
      if (this.recentEventsRing.length > MainBrain.RECENT_RING_MAX) {
        this.recentEventsRing.shift();
      }
    }));

    // 所有非大脑模块只能投递事实。普通进展不主动唤醒，下一次大脑回合统一读取。
    this.unsubs.push(this.bus.on('brain.notice', ev => {
      this.enqueueBrainNotice(ev.payload as BrainNoticeInput);
    }));
    this.unsubs.push(this.bus.on('goalagent.report', ev => {
      const p = ev.payload as { summary?: string; status?: string; requestId?: string; evidence?: unknown[] };
      if (this.goalAgentPort?.isManagedRequest?.(p.requestId)) return;
      const terminal = p.status === 'answered' || p.status === 'completed' || p.status === 'failed' || p.status === 'need_clarification';
      this.enqueueBrainNotice({
        source:'goalagent', topic:`goal_${p.status ?? 'progress'}`, label:'游戏体验',
        detail:p.summary ?? 'GoalAgent 正在推进目标',
        status:p.status === 'failed' ? 'fail' : p.status === 'completed' || p.status === 'answered' ? 'success' : 'progress',
        wake:terminal,
        dedupeKey:`goal_report:${p.requestId ?? p.summary ?? ev.id}:${p.status ?? 'progress'}`,
      });
    }));
    this.unsubs.push(this.bus.on('goalagent.continuation', ev => {
      this.enqueueGoalContinuation(ev.payload as GoalContinuationV2);
    }));
    this.unsubs.push(this.bus.on('goalagent.notification', ev => {
      const p = ev.payload as { eventType?:string; urgency?:string; episodeKey?:string; state?:string; summary?:string };
      this.enqueueBrainNotice({
        source:'goalagent', topic:`notification_${p.eventType ?? 'game'}`, label:p.state === 'resolved' ? '危险解除' : '游戏中发生重要事件',
        detail:p.summary ?? 'GoalAgent 发来一条游戏体验', status:p.state === 'resolved' ? 'success' : 'info',
        wake:p.urgency === 'critical' || p.urgency === 'high',
        dedupeKey:`goal_notification:${p.episodeKey ?? ev.id}:${p.state ?? 'opened'}`,
      });
    }));
  }

  /**
   * BUG-CROSS-32 · 终止 MainBrain 的全部输入与在途推理。
   * detachBody 不调用本方法；shutdown 后实例不可复用。
   */
  shutdown(reason = 'runtime_stopped'): void {
    if (this.closed) return;
    this.closed = true;

    this.activeTurnAbortController?.abort(reason);
    this.speechGateway.invalidate(reason);
    this.activeTurnAbortController = null;
    this.idleTurnAborted = true;
    this.idleAbortController?.abort(reason);
    this.idleAbortController = null;

    if (this.taskFeedbackTimer) clearTimeout(this.taskFeedbackTimer);
    this.taskFeedbackTimer = null;
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = null;
    this.goalContinuations.length = 0;
    this.continuationKeys.clear();
    this.noticeInbox.clear();
    this.pendingOwnerMsgs = [];
    this.pendingHistory = null;
    this.pendingEscalate = null;
    this.futileTask = null;
    this.busyBy = null;

    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.log(`shutdown · ${reason}`);
  }

  /**
   * Hard cancellation barrier. It invalidates speech authorization before
   * downstream task.cancelled events can arrive and drops all stale context.
   */
  cancelTaskContext(reason = 'cancelled_by_owner'): void {
    if (this.closed) return;
    this.speechGateway.invalidate(reason);
    this.activeTurnAbortController?.abort(reason);
    this.idleTurnAborted = true;
    this.idleAbortController?.abort(reason);
    this.pendingHistory = null;
    this._resolvePendingConversation(this.pendingConversation);
    this.pendingOwnerMsgs = [];
    this.noticeInbox.clear();
    if (this.taskFeedbackTimer) clearTimeout(this.taskFeedbackTimer);
    this.taskFeedbackTimer = null;
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = null;
    this.goalContinuations.length = 0;
    this.continuationKeys.clear();
    this.idleSuppressedByCancellation = true;
    this.goalAgentPort?.cancelSessions?.(reason);
    this.bus.publish('brain.context_cancelled', 'info', { reason });
  }

  /**
   * FEAT-L7-04：把 bus event payload 压成一行摘要（IDLE prompt 用）。
   */
  private _summarizeEvent(type: string, payload: unknown): string {
    const p = payload as Record<string, unknown> | null;
    if (!p) return type;
    switch (type) {
      case 'chat.from_owner':
        return `主人:"${String(p['message'] ?? '').slice(0, 30)}"`;
      case 'goalagent.report':
      case 'goalagent.notification':
        return String(p['summary'] ?? type).slice(0, 120);
      default:
        return type;
    }
  }

  /**
   * FEAT-L7-04：构造 IDLE 上下文（pos/hp/food/time/inv/threats/recentEvents）。
   * IDLE turn 用 · 注入 inventory / nearbyResources / threats / recentEvents 上下文。
   */
  buildIdleContext(): Record<string, unknown> {
    const now = Date.now();
    const recentEvents = this.recentEventsRing
      .slice(-5)
      .reverse()
      .map(e => ({
        type: e.type,
        summary: e.summary,
        agoSec: Math.round((now - e.ts) / 1000),
      }));

    return { recentGoalAgentEvents: recentEvents };
  }

  /**
   * BUG-CROSS-01 修④：v2Runtime futility_watch 检测到持续任务长时间零进展时调用。
   * 置位后下一次 IDLE 评估不再被"有活跃任务"压制，并以 escalate 文案唤醒慢脑。
   */
  noteFutileTask(info: { taskId: string; kind: string; stalledMs: number }): void {
    this.futileTask = info;
  }

  /** 任务恢复进展（位移/状态变化）→ 撤销徒劳标记，避免恢复后误 escalate */
  clearFutileTask(taskId: string): void {
    if (this.futileTask?.taskId === taskId) this.futileTask = null;
  }

  private enqueueBrainNotice(input: BrainNoticeInput): void {
    if (this.closed) return;
    const notice = this.noticeInbox.submit(input);
    if (!notice || !notice.wake) return;
    if (this.taskFeedbackTimer) clearTimeout(this.taskFeedbackTimer);
    this.taskFeedbackTimer = setTimeout(() => {
      this.taskFeedbackTimer = null;
      void this.spawnTaskFeedbackTurn();
    }, tuning().l7.taskFeedbackDebounceMs);
  }

  private enqueueGoalContinuation(continuation: GoalContinuationV2): void {
    if (this.closed) return;
    const key = goalContinuationDedupeKey(continuation);
    if (this.continuationKeys.has(key)) return;
    this.continuationKeys.add(key);
    this.goalContinuations.push(continuation);
    this.scheduleGoalContinuation();
  }

  private scheduleGoalContinuation(delayMs = tuning().l7.taskFeedbackDebounceMs): void {
    if (this.continuationTimer || this.closed) return;
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = null;
      void this.spawnGoalContinuationTurn();
    }, delayMs);
  }

  private async spawnGoalContinuationTurn(): Promise<void> {
    if (this.closed || this.goalContinuations.length === 0) return;
    if (this.busyBy !== null || this.pendingHistory !== null) {
      this.scheduleGoalContinuation(tuning().l7.taskFeedbackRetryMs);
      return;
    }
    const continuation = this.goalContinuations.shift();
    if (!continuation) return;
    const key = goalContinuationDedupeKey(continuation);
    this.busyBy = 'goal_continuation';
    const turnAbortController = new AbortController();
    this.activeTurnAbortController = turnAbortController;
    let requeued = false;
    const finish = () => {
      if (this.activeTurnAbortController === turnAbortController) this.activeTurnAbortController = null;
      if (turnAbortController.signal.aborted && !this.closed && !requeued) {
        if (continuation.session.origin === 'mainbrain_self') {
          this.goalAgentPort?.abandonSession?.(continuation.session.sessionId);
          this.continuationKeys.delete(key);
        } else {
          this.goalContinuations.unshift(continuation);
          requeued = true;
        }
      } else {
        this.continuationKeys.delete(key);
      }
      if (this.closed) return;
      this.busyBy = null;
      this.drainPendingOwnerMsg();
      if (this.goalContinuations.length > 0) this.scheduleGoalContinuation();
    };
    const execute = () => this.runTurn(
      '[GoalAgent 任务续接]',
      'goal_continuation',
      turnAbortController.signal,
      continuation,
    );
    if (this.asyncQueue) {
      this.asyncQueue.enqueue(() => execute().catch(error => {
        if (!turnAbortController.signal.aborted) this.log(`goal continuation error: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(finish));
    } else {
      try { await execute(); } catch (error) {
        if (!turnAbortController.signal.aborted) this.log(`goal continuation error: ${error instanceof Error ? error.message : String(error)}`);
      } finally { finish(); }
    }
  }

  /** 把队列渲染成"任务回执块"文本（system 反馈通道用 · 非主人发言）。 */
  private buildTaskFeedbackBlock(entries: BrainNotice[] = this.noticeInbox.peek()): string {
    if (entries.length === 0) return '';
    const icon = (s: string) => {
      if (s === 'success') return '✅ 成功';
      if (s === 'cancelled') return '⏹ 已取消';
      if (s === 'progress') return '🔄 进行中';
      if (s === 'info') return 'ℹ️ 信息';
      return '❌ 失败';
    };
    return entries
      .map(f => `· [${f.source}/${f.topic}]「${f.label}」${icon(f.status ?? 'info')}${f.detail ? '：' + f.detail : ''}`)
      .join('\n');
  }

  /**
   * 起一个 task_feedback turn 把回执喂回 LLM。
   * 占用中（主人/idle/feedback）或 ask_master 等待中 → 不抢，稍后重试（队列不丢）。
   */
  private async spawnTaskFeedbackTurn(): Promise<void> {
    if (this.closed) return;
    if (this.noticeInbox.size() === 0 || !this.noticeInbox.hasWakeNotice()) return;
    // 主人 > 任务反馈 > IDLE：占用或 ask_master 挂起时让位，排重试
    if (this.busyBy !== null || this.pendingHistory !== null) {
      if (!this.taskFeedbackTimer) {
        this.taskFeedbackTimer = setTimeout(() => {
          this.taskFeedbackTimer = null;
          void this.spawnTaskFeedbackTurn();
        }, tuning().l7.taskFeedbackRetryMs);
      }
      return;
    }

    // 先保留结构化批次，再清空共享队列。若主人抢占本 turn，可把原批次完整放回，避免结果丢失。
    const batch = this.noticeInbox.drain();
    const block = this.buildTaskFeedbackBlock(batch);
    if (!block) return;

    this.busyBy = 'task_feedback';
    this.bus.publish('l7.task_feedback_turn', 'info', { block });
    this.log(`task_feedback turn · 推送任务回执给 LLM:\n${block}`);

    const turnAbortController = new AbortController();
    this.activeTurnAbortController = turnAbortController;
    let batchRequeued = false;
    const finish = () => {
      if (this.activeTurnAbortController === turnAbortController) {
        this.activeTurnAbortController = null;
      }
      if (turnAbortController.signal.aborted && !this.closed && !batchRequeued) {
        // 原批次排在执行期间新到回执之前，保持时间顺序；finish 只允许回放一次。
        this.noticeInbox.requeueFront(batch);
        batchRequeued = true;
        this.bus.publish('l7.task_feedback_requeued', 'info', { count: batch.length });
      }
      if (this.closed) return;
      this.busyBy = null;
      this.bus.publish('l7.task_feedback_finished', 'info', {});
      this.drainPendingOwnerMsg();
      // 期间又积压新终态 → 再排一轮
      if (this.noticeInbox.hasWakeNotice() && !this.taskFeedbackTimer) {
        this.taskFeedbackTimer = setTimeout(() => {
          this.taskFeedbackTimer = null;
          void this.spawnTaskFeedbackTurn();
        }, tuning().l7.taskFeedbackDebounceMs);
      }
    };

    if (this.asyncQueue) {
      this.asyncQueue.enqueue(() =>
        this.runTurn(block, 'task_feedback', turnAbortController.signal)
          .catch((e: unknown) => {
            if (this.closed) return;
            const m = e instanceof Error ? e.message : String(e);
            this.bus.publish('llm.turn_error', 'recoverable', { error: m, message: '[task_feedback]' });
            this.log(`task_feedback turn error: ${m}`);
          })
          .finally(finish),
      );
    } else {
      try {
        await this.runTurn(block, 'task_feedback', turnAbortController.signal);
      } catch (e) {
        if (this.closed) return;
        const m = e instanceof Error ? e.message : String(e);
        this.log(`task_feedback turn error: ${m}`);
      } finally {
        finish();
      }
    }
  }

  private async spawnIdleTurn(): Promise<void> {
    if (this.closed) return;
    if (this.busyBy !== null) return;
    if (this.pendingHistory !== null || this.idleSuppressedByCancellation) return;
    if (this.isBenchActive()) {
      this.log('IDLE · TestBench 运行中，跳过主动决策');
      return;
    }
    // 有活跃任务时不触发 IDLE · 防止"已在执行任务却说我空闲"
    // BUG-CROSS-01 修④：徒劳任务（长时间零进展）不再压制 IDLE——放行让大脑看一眼
    const activeTaskCount = this.getRunningTaskCount?.() ?? 0;
    const futile = this.futileTask && Date.now() >= this.futileEscalateCooldownUntil ? this.futileTask : null;
    if (activeTaskCount > 0 && !futile) {
      this.log(`IDLE · 跳过（有 ${activeTaskCount} 个活跃任务）`);
      return;
    }
    // BUG-CROSS-65：普通主动闲聊无论是否挂载游戏身体都必须经过同一个 Profile 级治理门。
    // 徒劳任务升级是必要故障通知，不属于普通主动闲聊，因此保留独立通道。
    if (!futile && this.companion) {
      const decision = this.companion.recordInitiative();
      this.bus.publish('companion.initiative_decision', decision.allowed ? 'info' : 'suggestion', decision);
      if (!decision.allowed) return;
    }
    // 缺陷 C：IDLE 冷却 · 空转后 5 分钟内不再刷话术
    if (Date.now() < this.idleCooldownUntil) {
      const remainSec = Math.ceil((this.idleCooldownUntil - Date.now()) / 1000);
      this.log(`IDLE · 冷却中（剩余 ${remainSec}s）· 跳过`);
      return;
    }

    // MainBrain 不再读取感知或直接创建游戏任务；自主目标同样交给 GoalAgentPort。
    this.pendingEscalate = null; // FEAT-L6-04：本轮 escalate 检测前清零

    // FEAT-L6-04：连败 escalate → 强制唤醒慢脑做高层决策 + 要求汇报主人（不再泛泛空闲）
    // BUG-CROSS-01 修④：徒劳任务 escalate → 同通道，告知"任务卡死零进展"
    const esc = this.pendingEscalate as { triggerId: string; reason: string; count: number } | null;
    let idleMessage = '[idle] 当前无任务，主动找事做';
    if (esc) {
      idleMessage = `[idle:escalate] 你已连续 ${esc.count} 次执行「${esc.triggerId}」失败（${esc.reason}），快脑已退避、停止重试同样的做法。请基于当前处境重新做高层决策（换材料/换地方/先睡觉/合成替代/或其它），并**主动把当前困境与你接下来的打算告诉主人**。`;
      this.bus.publish('l7.escalate_to_brain', 'suggestion', { triggerId: esc.triggerId, reason: esc.reason, count: esc.count });
      this.log(`IDLE · ⚠ 连败 escalate → 强制唤醒慢脑（${esc.triggerId} · ${esc.reason}）· 要求换策略并汇报主人`);
    } else if (futile) {
      const min = Math.round(futile.stalledMs / 60_000);
      idleMessage = `[idle:escalate] 你的「${futile.kind}」任务已 ${min} 分钟零进展（原地未动、目标未达成），疑似卡死。请基于当前处境重新决策：取消/重建该任务、改用其它方式（如让主人给坐标、goto_position 直达），并**主动把困境告诉主人**。`;
      this.bus.publish('l7.escalate_to_brain', 'suggestion', { taskId: futile.taskId, kind: futile.kind, reason: 'futile_no_progress', stalledMs: futile.stalledMs });
      this.log(`IDLE · ⚠ 徒劳任务 escalate → 唤醒慢脑（${futile.kind} · ${min}min 零进展）`);
      this.futileTask = null;
      this.futileEscalateCooldownUntil = Date.now() + tuning().futility.escalateCooldownMs;
    }
    this.busyBy = 'idle';
    this.idleTurnAborted = false;
    this.idleAbortController = new AbortController();
    this.bus.publish('l7.idle_turn_started', 'info', { tick: Date.now() });
    this.log('IDLE 节拍 · 触发主动 turn');

    // FEAT-L7-04：网络瞬断标志 · _maybeShortCooldown 设置 · finish 跳过 5 分钟长冷却
    this.idleShortCooldownPending = false;

    const finish = () => {
      if (this.closed) return;
      const aborted = this.idleTurnAborted;
      this.idleTurnAborted = false;
      this.busyBy = null;

      if (aborted) {
        // 缺陷 B：主人抢占 IDLE · 结果丢弃
        this.log('IDLE turn 被主人抢占 · 结果已丢弃');
        this.bus.publish('l7.idle_turn_aborted', 'info', { tick: Date.now() });
      } else if (this.idleShortCooldownPending) {
        // FEAT-L7-04：本次 turn 因网络瞬断已挂短冷却，不覆盖成 5 分钟
        this.idleShortCooldownPending = false;
        this.bus.publish('l7.idle_turn_finished', 'info', { tick: Date.now(), netError: true });
      } else {
        // 缺陷 C：检查是否有真实任务产出，没有则进冷却
        const runningTasks = this.getRunningTaskCount?.() ?? -1;
        if (runningTasks === 0) {
          this.idleCooldownUntil = Date.now() + MainBrain.IDLE_COOLDOWN_MS;
          this.log(`IDLE 空转（无新任务）· 进入 ${MainBrain.IDLE_COOLDOWN_MS / 60000} 分钟冷却`);
        }
        this.bus.publish('l7.idle_turn_finished', 'info', { tick: Date.now() });
      }
      // 无论 aborted 与否，turn 结束后立即处理排队的主人消息
      this.drainPendingOwnerMsg();
    };

    const idleSignal = this.idleAbortController.signal;

    if (this.asyncQueue) {
      this.asyncQueue.enqueue(() =>
        this.runTurn(idleMessage, 'idle', idleSignal)
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes('aborted') && !msg.includes('timeout')) {
              this.bus.publish('llm.turn_error', 'recoverable', { error: msg, message: idleMessage });
            }
            this.log(`idle turn error: ${msg}`);
            this._maybeShortCooldown(msg);
          })
          .finally(finish),
      );
    } else {
      try {
        await this.runTurn(idleMessage, 'idle', idleSignal);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('aborted') && !msg.includes('timeout')) {
          this.bus.publish('l7.turn_error', 'recoverable', { error: msg });
        }
        this.log(`idle turn error: ${msg}`);
        this._maybeShortCooldown(msg);
      } finally {
        finish();
      }
    }
  }

  /**
   * FEAT-L7-04：网络/连接瞬断时启用短冷却（90s），不进 5 分钟黑屏。
   * 仅对 "Connection error" / network / ECONNRESET / fetch failed 等模式生效。
   */
  private _maybeShortCooldown(errMsg: string): void {
    const lower = errMsg.toLowerCase();
    const isNetIssue =
      lower.includes('connection') ||
      lower.includes('econnreset') ||
      lower.includes('etimedout') ||
      lower.includes('fetch failed') ||
      lower.includes('socket hang up') ||
      lower.includes('network');
    if (!isNetIssue) return;
    // 标记 + 立即设短冷却；finish() 看到标志则跳过 5 分钟覆盖
    this.idleShortCooldownPending = true;
    this.idleCooldownUntil = Date.now() + MainBrain.IDLE_NET_ERROR_COOLDOWN_MS;
    this.log(`IDLE 网络瞬断 · 短冷却 ${MainBrain.IDLE_NET_ERROR_COOLDOWN_MS / 1000}s（非 5 分钟）`);
  }

  /**
   * Web UI / 外部直聊入口 · 跳过 AddressDetector。
   * 网页聊天框的消息明确就是对本 bot 说的（isDirectMessage），无需判断"是否在叫我"。
   */
  handleDirectMessage(message: string): void {
    if (this.closed) return;
    void this.tryHandle(message, { skipAddressCheck: true });
  }

  private async tryHandle(message: string, opts?: { skipAddressCheck?: boolean }): Promise<void> {
    if (this.closed) return;
    // TestBench 是显式控制命令，必须在 AddressDetector 前处理，避免 "#test" 被当作普通未点名聊天丢弃。
    if (this.onBenchCommand?.(message)) return;
    // ① AddressDetector：判断消息是否在叫 bot · 不是则 drop
    //    Web UI 直聊（skipAddressCheck）跳过此步——网页消息天然是对本 bot 说的。
    if (!opts?.skipAddressCheck) {
      // chat.from_owner 已由上游完成身份判定；MainBrain 不读取实体列表做路由。
      const nearbyPlayers: string[] = [];
      const addrResult = detectAddress(message, {
        botName: this.cfg.botName ?? 'MineFriend',
        isDirectMessage: false,
        nearbyPlayers,
      });
      if (addrResult === 'not_addressed') {
        this.bus.publish('chat.dropped_not_addressed', 'info', { message, nearbyPlayers });
        this.log(`dropped (not_addressed): ${message}`);
        return;
      }
    }

    // BUG-CROSS-16 · 停止是主人主权控制：先中断旧链，再让同一句“改成……”进入正常规划。
    // 放在 AddressDetector 后防止旁人误停；放在 busy 判断前保证物理执行立即收手。
    if (this.onOwnerCancellation && isTaskCancellationRequest(message)) {
      // 旧 Owner/任务回执 turn 也是任务生产者；先切断上游，避免取消后迟到 start_task。
      if (this.busyBy === 'owner' || this.busyBy === 'task_feedback' || this.busyBy === 'goal_continuation') {
        this.activeTurnAbortController?.abort();
      }
      const cancelled = this.onOwnerCancellation(message);
      this.bus.publish('owner.cancel_applied', 'info', { message, cancelled });
      this.log(`owner cancellation applied · cancelled=${cancelled} · ${message.slice(0, 48)}`);
      const followUp = stripTaskCancellationPrefix(message);
      // Pure cancellation still enters the normal MainBrain → GoalAgent cancel
      // protocol so the stop has an auditable request/report and a character reply.
      // The deterministic barrier above remains first so provider latency cannot
      // delay physical cancellation. Reassignment continues with only the new goal.
      if (followUp) message = followUp;
      this.idleSuppressedByCancellation = false;
    } else {
      this.idleSuppressedByCancellation = false;
    }

    // A fresh owner message is itself recent social activity. Do not let the
    // next heartbeat open an IDLE turn that echoes the conversation just sent.
    this.idleCooldownUntil = Math.max(
      this.idleCooldownUntil,
      Date.now() + MainBrain.IDLE_COOLDOWN_MS,
    );

    // ② 缺陷 A + B：busy 时主人消息绝不丢弃
    if (this.busyBy !== null) {
      if (this.busyBy === 'idle') {
        // 缺陷 B：主人抢占 IDLE · 立即 abort LLM 请求，不再等待
        this.idleTurnAborted = true;
        this.enqueueOwnerMessage(message, !!opts?.skipAddressCheck);
        this.idleAbortController?.abort();  // ← 立即中断 LLM IDLE 请求
        this.log(`owner preempts IDLE · queued: ${message}`);
      } else if (this.busyBy === 'task_feedback' || this.busyBy === 'goal_continuation') {
        // FEAT-L7-16 AC5：主人优先于系统回执。先入 FIFO 再 abort；feedback finish 会回放原批次并先 drain 主人。
        this.enqueueOwnerMessage(message, !!opts?.skipAddressCheck);
        this.activeTurnAbortController?.abort();
        this.log(`owner preempts ${this.busyBy} · queued: ${message}`);
      } else {
        // owner 进行中：按 arrival 顺序排队，不能覆盖中间消息。
        this.enqueueOwnerMessage(message, !!opts?.skipAddressCheck);
        this.log(`busy(owner) · queued chat: ${message}`);
      }
      return;
    }

    // ③ 正式开始 owner turn
    this.busyBy = 'owner';
    const turnAbortController = new AbortController();
    this.activeTurnAbortController = turnAbortController;
    this.bus.publish('l7.turn_started', 'info', { message, mode: this.modeName() });

    if (this.asyncQueue) {
      // 异步化：不阻塞 tick 主循环 · 结果通过 bus 事件广播
      this.asyncQueue.enqueue(() =>
        this.runTurn(message, 'owner', turnAbortController.signal)
          .then(result => {
            if (result.pendingAskMaster) {
              this.log(`turn paused at ask_master · 等主人答复`);
            }
            this.bus.publish('llm.turn_done', 'info', { message, pendingAskMaster: result.pendingAskMaster });
            return result;
          })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (turnAbortController.signal.aborted) {
              this.log(`owner turn preempted: ${message.slice(0, 48)}`);
            } else {
              this.bus.publish('llm.turn_error', 'recoverable', { error: msg, message });
              this.log(`turn error: ${msg}`);
            }
          })
          .finally(() => {
            if (this.activeTurnAbortController === turnAbortController) {
              this.activeTurnAbortController = null;
            }
            if (this.closed) return;
            this.busyBy = null;
            this.bus.publish('l7.turn_finished', 'info', { message });
            this.drainPendingOwnerMsg();
          }),
      );
    } else {
      // 同步路径（无 asyncQueue）· 保持原有行为
      try {
        const result = await this.runTurn(message, 'owner', turnAbortController.signal);
        if (result.pendingAskMaster) {
          this.log(`turn paused at ask_master · 等主人答复`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (turnAbortController.signal.aborted) {
          this.log(`owner turn preempted: ${message.slice(0, 48)}`);
        } else {
          this.bus.publish('l7.turn_error', 'recoverable', { error: msg });
          this.log(`turn error: ${msg}`);
        }
      } finally {
        if (this.activeTurnAbortController === turnAbortController) {
          this.activeTurnAbortController = null;
        }
        if (this.closed) return;
        this.busyBy = null;
        this.bus.publish('l7.turn_finished', 'info', { message });
        this.drainPendingOwnerMsg();
      }
    }
  }

  /**
   * 处理排队中的主人消息（turn 结束 finally 里调用）。
   * 排队时已通过 AddressDetector，直接 skipAddressCheck=true 避免重复校验。
   */
  private drainPendingOwnerMsg(): void {
    if (this.closed) return;
    const pending = this.pendingOwnerMsgs.shift();
    if (!pending) return;
    this.log(`处理排队的主人消息: ${pending.message}`);
    void this.tryHandle(pending.message, { skipAddressCheck: pending.skipAddressCheck });
  }

  private enqueueOwnerMessage(message: string, skipAddressCheck: boolean): void {
    if (this.closed) return;
    if (this.pendingOwnerMsgs.length >= MainBrain.OWNER_QUEUE_MAX) {
      this.bus.publish('chat.queue_overflow', 'recoverable', { max: MainBrain.OWNER_QUEUE_MAX, message });
      this.log(`owner queue overflow · rejected: ${message}`);
      return;
    }
    this.pendingOwnerMsgs.push({ message, skipAddressCheck });
  }

  private async runTurn(
    message: string,
    turnKind: TurnKind = 'owner',
    abortSignal?: AbortSignal,
    continuation?: GoalContinuationV2,
  ): Promise<{ pendingAskMaster: boolean }> {
    if (this.closed || abortSignal?.aborted) throw new Error('turn aborted');
    const turnNumber = this.turnSeq++;
    const turnId = `turn-${Date.now()}-${turnNumber}`;
    if (turnKind === 'owner' && this.llmTraceRecorder) {
      await this.llmTraceRecorder.append({
        occurredAt: new Date().toISOString(),
        type: 'interaction.received',
        correlationId: turnId,
        interactionSessionId: turnId,
        agent: 'mainbrain',
        turn: turnNumber,
        payload: {
          sender: this.cfg.ownerName,
          message,
          chatSessionId: this.chatSessionId,
          turnKind,
        },
      });
    }
    // FEAT-L7-16 · 角色通道：仅 owner turn 把 message 记成 conversation 的 owner；
    //   idle / task_feedback 是系统触发，绝不记成主人发言（只记 bot 产出），防污染对话历史。
    const recordTurn = (result: { pendingAskMaster: boolean; history?: HistoryEntry[]; botReply?: string }) => {
      if (turnKind === 'owner') this._recordConversation(turnId, message, result);
      else this._recordNonOwnerReply(turnId, turnKind, result);
    };
    this.speechGateway.beginTurn(turnId);
    if (turnKind === 'owner') this.goalAgentPort?.beginPlayerTurn?.(turnId, message);
    if (turnKind === 'goal_continuation' && continuation) {
      this.goalAgentPort?.beginContinuation?.(turnId, continuation.session.sessionId);
    }

    try {
      // GoalAgent 决定“还缺哪项信息”，MainBrain 负责把问题说给玩家。
      // 使用协议原文，避免把澄清问题自由改写成进度承诺或凭空补全答案；
      // 玩家回答仍由正常 MainBrain owner turn 接收并决定下一次委托。
      if (turnKind === 'goal_continuation' && continuation?.session.state === 'awaiting_player') {
        const question = continuation.triggeringReport.summary || '这个任务还缺一项信息，你能再说具体一点吗？';
        this.speechGateway.commit(question, 'ask_master');
        this.goalAgentPort?.markReplied?.(continuation.session.sessionId);
        const result = { pendingAskMaster: false, botReply: question };
        recordTurn(result);
        return { pendingAskMaster: false };
      }
      // LLM 模式（一切经大脑决策 · 无旁路，保证"脑子和手脚一致"）
      if (this.llmLoop) {
        const wasPending = this.pendingHistory !== null;
        const priorHistory = this.pendingHistory ?? [];
        const resumedPendingConversation = this.pendingConversation;
        this.pendingHistory = null; // 取出即清，避免重入
        const isFeedback = turnKind === 'task_feedback';
        const isContinuation = turnKind === 'goal_continuation' && !!continuation;
        const queuedNotices = isFeedback ? [] : this.noticeInbox.drain();
        const noticeBlock = this.buildTaskFeedbackBlock(queuedNotices);
        const continuationBlock = continuation ? this.buildGoalContinuationBlock(continuation) : '';
        const systemFeedback = [isFeedback ? message : '', continuationBlock, noticeBlock].filter(Boolean).join('\n');
        const userMsg = isContinuation
          ? '[内部任务续接，不是朋友的新发言] 请继续处理同一个玩家任务'
          : isFeedback
            ? '[内部状态触发，不是朋友发言] 请根据事实自行决定：自然告知、询问，或保持安静'
            : message;
        const allowedTools = isContinuation
          ? this.continuationAllowedTools(continuation)
          : isFeedback
            ? ['say', 'ask_master', 'stay_silent']
            : undefined;
        let result;
        try {
          result = await this.llmLoop.run(
            userMsg,
            priorHistory,
            abortSignal,
            {
            systemFeedback: systemFeedback || undefined,
            allowedTools,
            terminalSpeechPolicy: continuation ? {
              validate: text => this.goalReportSpeechPolicy.validate(
                continuation.triggeringReport,
                text,
                this.getGamePresence(),
              ),
            } : undefined,
            traceContext: {
              agent: 'mainbrain',
              correlationId: turnId,
              interactionSessionId: turnId,
              goalSessionId: continuation?.session.sessionId,
              taskId: continuation?.triggeringReport.requestId,
              turn: turnNumber,
            },
            },
          );
        } catch (error) {
          if (wasPending && this.pendingHistory === null) this.pendingHistory = priorHistory;
          throw error;
        }
        if (this.closed || abortSignal?.aborted) {
          if (wasPending && this.pendingHistory === null) this.pendingHistory = priorHistory;
          throw new Error('turn aborted');
        }
        this._resolvePendingConversation(resumedPendingConversation);
        if (result.pendingAskMaster) {
          this.pendingHistory = result.history;
        }
        if (continuation?.session.replyObligation === 'must_reply' && !this._extractBotReply(result)) {
          const fallback = continuation.triggeringReport.summary || '这个任务目前还没有可靠结果。';
          this.speechGateway.commit(fallback, continuation.session.state === 'awaiting_player' ? 'ask_master' : 'say');
          (result as typeof result & { botReply?: string }).botReply = fallback;
          if (continuation.session.state === 'awaiting_player') this.pendingHistory = result.history;
        }
        if (continuation && this._extractBotReply(result)) {
          this.goalAgentPort?.markReplied?.(continuation.session.sessionId);
        }
        recordTurn(result);
        return { pendingAskMaster: result.pendingAskMaster };
      }
      const result = {
        pendingAskMaster: false,
        botReply: '这条消息已收到，但伙伴尚未配置 AI Agent，暂时无法生成回答。请到“全局设置 → LLM Agent 配置”添加 API，再到伙伴设置中选择它。',
      };
      this.speechGateway.commit(result.botReply, 'say');
      recordTurn(result);
      return { pendingAskMaster: result.pendingAskMaster };
    } finally {
      if (turnKind === 'owner' || turnKind === 'goal_continuation') this.goalAgentPort?.endPlayerTurn?.(turnId);
      this.speechGateway.endTurn(turnId);
    }
  }

  private buildGoalContinuationBlock(continuation: GoalContinuationV2): string {
    const { session, triggeringReport: report } = continuation;
    const context = buildMainBrainContext(session, report);
    return [
      `MainBrainContext=${JSON.stringify(context)}`,
      `InteractionSession=${session.sessionId}`,
      `玩家原始任务：${session.originalText}`,
      `当前完整任务：${session.desiredOutcome}`,
      `会话状态：${session.state}`,
      `回复义务：${session.replyObligation}`,
      `GoalAgent 报告(${report.status})：${report.summary}`,
      this.goalReportSpeechPolicy.instruction(report, this.getGamePresence()),
      `本轮允许决定：${continuation.allowedDecisions.join(', ')}`,
      session.state === 'awaiting_player'
        ? '必须把 GoalAgent 的澄清问题自然地问玩家，不得静默，不得自行猜答案。'
        : session.state === 'ready_for_decision'
          ? '可以回复，或只委托一次与该 session 关联的后续完整任务。'
          : '根据报告向玩家回复；不得再次提交重复任务。',
    ].join('\n');
  }

  private continuationAllowedTools(continuation: GoalContinuationV2): string[] {
    if (continuation.session.state === 'ready_for_decision') {
      return ['say', 'ask_master', 'submit_goal_request'];
    }
    if (continuation.session.state === 'awaiting_player') return ['ask_master', 'say'];
    return continuation.session.replyObligation === 'must_reply' ? ['say'] : ['say', 'stay_silent'];
  }

  /**
   * 将本轮对话（owner 消息 + bot 回复）持久化到 Memory。
   * turn 结束后调用，不阻塞主循环。
   */
  private _recordConversation(
    turnId: string,
    ownerMessage: string,
    result: { pendingAskMaster: boolean; history?: HistoryEntry[]; botReply?: string },
  ): void {
    if (!this.memory && !this.chatMemory) return;

    const now = Date.now();

    // 记录 owner 消息
    const ownerEntry: ConversationEntry = {
      id: `conv-${now}-owner`,
      turnId,
      role: 'owner',
      content: ownerMessage,
      timestamp: now,
      meta: { source: 'game_chat' },
    };
    this.memory?.record('conversation', ownerEntry);
    this.chatMemory?.recordMessage({ id: ownerEntry.id, sessionId: this.chatSessionId, role: 'owner', content: ownerEntry.content, timestamp: ownerEntry.timestamp });

    // 记录 bot 回复
    const botContent = this._extractBotReply(result);
    if (botContent) {
      const toolCalls = this._extractToolCallSummary(result.history);
      const botEntry: ConversationEntry = {
        id: `conv-${now}-bot`,
        turnId,
        role: 'bot',
        content: botContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: now + 1,
        meta: {
          source: 'game_chat',
          isPending: result.pendingAskMaster,
          ...(result.pendingAskMaster
            ? { llmContinuation: serializeMainBrainPendingHistory(result.history ?? []) }
            : {}),
        },
      };
      this.memory?.record('conversation', botEntry);
      if (result.pendingAskMaster) this.pendingConversation = botEntry;
      this.chatMemory?.recordMessage({ id: botEntry.id, sessionId: this.chatSessionId, role: 'bot', content: botEntry.content, timestamp: botEntry.timestamp });
    }
    this._recordSavedChatFacts(result.history, ownerEntry.id);
    this.chatMemory?.maybeFlush(this.chatSessionId);
  }

  /**
   * FEAT-L7-16 · 非主人 turn（idle / task_feedback）只记 bot 产出，**不记 owner 输入**。
   * 修复历史 bug：此前 idle 触发文本被当 role:'owner' 存进对话历史污染上下文。
   * bot 若 say 了（主人听得见的话）才记 role:'bot'；纯内部 tool 调用无 say → 不记。
   */
  private _recordNonOwnerReply(
    turnId: string,
    kind: TurnKind,
    result: { pendingAskMaster: boolean; history?: HistoryEntry[]; botReply?: string },
  ): void {
    if (!this.memory && !this.chatMemory) return;
    const botContent = this._extractBotReply(result);
    if (!botContent) return;
    const now = Date.now();
    const toolCalls = this._extractToolCallSummary(result.history);
    const botEntry: ConversationEntry = {
      id: `conv-${now}-bot`,
      turnId,
      role: 'bot',
      content: botContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      timestamp: now,
      meta: {
        source: 'game_chat',
        isPending: result.pendingAskMaster,
        ...(result.pendingAskMaster
          ? { llmContinuation: serializeMainBrainPendingHistory(result.history ?? []) }
          : {}),
      },
    };
    void kind; // kind 仅用于路由，不入库（避免污染 conversation meta 严格类型）
    this.memory?.record('conversation', botEntry);
    if (result.pendingAskMaster) this.pendingConversation = botEntry;
    this.chatMemory?.recordMessage({ id: botEntry.id, sessionId: this.chatSessionId, role: 'bot', content: botEntry.content, timestamp: botEntry.timestamp });
    this.chatMemory?.maybeFlush(this.chatSessionId);
  }

  private _resolvePendingConversation(entry: ConversationEntry | null): void {
    if (!entry) return;
    if (this.pendingConversation?.id === entry.id) this.pendingConversation = null;
    this.memory?.record('conversation', {
      ...entry,
      meta: {
        ...entry.meta,
        isPending: false,
        llmContinuation: undefined,
      },
    });
  }

  /** 从 turn 结果中提取 bot 说的话 */
  private _extractBotReply(result: { history?: HistoryEntry[]; botReply?: string }): string | null {
    // rule 模式直接有 botReply
    if (result.botReply) return result.botReply;
    // LLM 模式从 history 中找最后一个 say/ask_master 调用
    if (result.history) {
      for (let i = result.history.length - 1; i >= 0; i--) {
        const h = result.history[i];
        if (h.call.tool === 'say' || h.call.tool === 'ask_master' || h.call.tool === 'propose_chat') {
          const input = h.call.input as Record<string, unknown>;
          return (input['text'] as string) ?? null;
        }
      }
    }
    return null;
  }

  /** 从 LLM history 中提取工具调用摘要 */
  private _extractToolCallSummary(history?: HistoryEntry[]): Array<{ tool: string; input: Record<string, unknown>; result: 'ok' | 'error'; brief?: string }> {
    if (!history) return [];
    return history
      .filter(h => h.call.tool !== 'say' && h.call.tool !== 'ask_master' && h.call.tool !== 'propose_chat')
      .map(h => ({
        tool: h.call.tool,
        input: h.call.input as Record<string, unknown>,
        result: (h.result as { ok?: boolean })?.ok !== false ? ('ok' as const) : ('error' as const),
        brief: h.call.tool,
      }));
  }

  /** 兼容既有 save_memory：Markdown 仍由工具写入，同时归一到 Profile 事实库并绑定本轮主人原文。 */
  private _recordSavedChatFacts(history: HistoryEntry[] | undefined, sourceMessageId: string): void {
    if (!this.chatMemory || !history) return;
    for (const entry of history) {
      if (entry.call.tool !== 'save_memory' || (entry.result as { ok?: boolean })?.ok === false) continue;
      const text = typeof entry.call.input.text === 'string' ? entry.call.input.text.trim() : '';
      if (!text) continue;
      const scope = entry.call.input.scope === 'memory' ? 'agent' : 'user';
      this.chatMemory.saveToolFact(text, scope, [sourceMessageId]);
    }
  }

  private modeName(): string {
    return this.llmLoop ? 'llm' : 'rule';
  }

  private log(msg: string): void {
    this.cfg.onLog?.(`[MainBrain] ${msg}`);
  }
}

export function goalContinuationDedupeKey(continuation: GoalContinuationV2): string {
  const report = continuation.triggeringReport;
  const eventKey = report.update?.dedupeKey ?? report.meta.messageId ?? report.status;
  return `${continuation.session.sessionId}:${report.requestId}:${report.status}:${eventKey}`;
}
