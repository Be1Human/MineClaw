import { BodyActionService } from './task/execution/bodyActionService.js';
/**
 * v2 Runtime 装配器 · "跟着我" 场景所需模块全部组装
 *
 * 用法：
 *   const rt = new V2Runtime({ game, nav, ownerName: 'qxy' });
 *   rt.start();
 *   ...
 *   rt.stop();
 *
 * 在 BotRuntime 里用 env V2_ENABLED=1 切换到 v2。
 */

import type { GameAdapter } from '../adapter/GameAdapter.js';
import type { NavigationAdapter } from '../adapter/NavigationAdapter.js';
import { randomUUID } from 'node:crypto';

import { EventBusV2 } from './infra/eventBus.js';
import {
  LlmTraceEventStore,
  LlmTraceQueryService,
  type LlmTraceEventType,
  type LlmTraceJsonValue,
} from './infra/llmTrace/index.js';
import { NON_DURABLE_EVENT_TYPES, isDurableEventType } from './infra/eventDurability.js';
import { MemoryV2 } from './infra/memory.js';
import { BotMemoryStore } from './infra/botMemory.js';
import { ChatMemoryService, LocalTokenEmbeddingProvider } from './infra/chatMemory.js';
import { ChatMemoryConsolidator, LLMMemoryFactExtractor } from './infra/chatMemoryConsolidation.js';
import {
  MemoryConsolidationScheduler,
  type MemoryConsolidationCapabilitySnapshot,
} from './infra/memoryConsolidationScheduler.js';
import { EpisodeAssembler, EpisodeStore, RuntimeEpisodeCapture } from './memory/episode/index.js';
import { ChatMemoryRecallProvider, MemoryCatalog, MemorySystem, formatPlanningMemoryContext } from './memory/index.js';
import { GoalAgentMemoryKnowledgeAdapter } from './memory/goalAgentMemoryKnowledge.js';
import { NarrationHub } from './narration/narrationHub.js';
import { TemplateRenderer } from './narration/templateRenderer.js';
import { AsyncTaskQueue } from './infra/asyncTaskQueue.js';
import { TickRegistry, TickRate } from './infra/tickRegistry.js';
import { Heartbeat, type HeartbeatConfig } from './infra/heartbeat.js';
import { PerceptionPipeline } from './perception/pipeline.js';
import { TaskRuntime } from './task/taskRuntime.js';
import { PreconditionRegistry } from './task/preconditionRegistry.js';
import { TriggerOutcomeMemory } from './decision/triggerOutcomeMemory.js';
import { tuning } from './infra/tuning.js';
import { gamePresenceFromWorld } from './gamePresenceContext.js';
import {
  buildRuntimePluginKernel,
  createRuntimeObservationPorts,
  type RuntimePluginKernelResult,
} from './infra/pluginRuntimeBridge.js';
import type { FailureCode } from './task/failureReason.js';
import { TaskRegistry } from './knowledge/taskRegistry.js';
import { createRuntimeCapabilityKnowledge } from './capabilities/capabilityRuntimeProjection.js';
import { GoalAgentRoundToolRuntime } from './task/goalAgent/goalAgentRoundTools.js';
import { GoalDraftCompiler } from './task/goalAgent/goalDraftCompiler.js';
import { GoalPlanAuthority } from './task/goalAgent/goalPlanAuthority.js';
import { CapabilityProgressPolicy } from './capabilities/capabilityProgressPolicy.js';
import {
  DEFAULT_GOAL_TARGETS,
  InMemoryGoalKnowledgePort,
} from './knowledge/goalTargetKnowledge.js';
import { DomainKnowledgeRegistry } from './knowledge/domainKnowledge.js';
import { buildRecipeKnowledgeDocuments } from './knowledge/recipeKnowledge.js';
import { confirmCompletion } from './decision/goalAgentPort/completionConfirmationGate.js';
import { AgentSkillRegistry } from './skills/skillRegistry.js';
import { GoalAgentSkillKnowledgeAdapter } from './skills/goalAgentSkillKnowledge.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { RuntimeSupervisor } from './decision/supervisor.js';
import { MainBrain } from './decision/mainBrain.js';
import {
  GoalCapabilityDispatcher,
  GoalCapabilityRouter,
  GoalAgentPort,
  type GoalReportV2,
  type GoalRequestV2,
  type GoalStatusProbeV2,
  type GoalStatusSnapshotV2,
} from './decision/goalAgentPort/index.js';
import { FollowStrategy } from './strategy/followStrategy.js';
import { ReflexStrategy } from './strategy/reflexStrategy.js';
import { FarmStrategy } from './strategy/farmStrategy.js';
import { GatherStrategy } from './strategy/gatherStrategy.js';
import { GotoStrategy } from './strategy/gotoStrategy.js';
import { ProvisionStrategy } from './strategy/provisionStrategy.js';
import { SurvivalStrategy } from './strategy/survivalStrategy.js';
import { EscapeStrategy } from './strategy/pitEscapeStrategy.js';
import { ResourceResolver } from './task/resourceResolver.js';
import {
  InventoryProvider,
  CraftProvider,
  ChestMemoryProvider,
} from './task/resourceProvider.js';
import { DecisionPolicy } from './task/decisionPolicy.js';
import { createDefaultAtomicContractRegistry } from './atomic/contracts/defaultContracts.js';
import type { BusEvent, WorldStateView } from './types.js';
import { LLMClient } from './cognitive/llm/LLMClient.js';
import { BehaviorRegistry } from './behavior/behaviorRegistry.js';
import { FollowBehavior } from './behavior/followBehavior.js';
import { FarmBehavior } from './behavior/farmBehavior.js';
import { CombatBehavior } from './behavior/combatBehavior.js';
import { FleeBehavior } from './behavior/fleeBehavior.js';
import { GatherBehavior } from './behavior/gatherBehavior.js';
import { CraftBehavior } from './behavior/craftBehavior.js';
import { ChestWithdrawBehavior } from './behavior/chestWithdrawBehavior.js';
import { DepositToChestBehavior } from './behavior/depositToChestBehavior.js';
import { DeliverToOwnerBehavior } from './behavior/deliverToOwnerBehavior.js';
import { PlaceRelativeBehavior } from './behavior/placeRelativeBehavior.js';
import { PickupGroundItemBehavior } from './behavior/pickupGroundItemBehavior.js';
import { CriticRegistry, RuleCritic, makeVerdict } from './task/critic/ruleCritic.js';
import { buildPostconditionFn } from './task/critic/postconditionBuilder.js';
import { SubtaskInjector } from './task/subtaskInjector.js';
import { StrategyStore } from './task/strategy/strategyStore.js';
import { WorldScanCapability } from './capability/worldScanCapability.js';
import { MineralProbeCapability } from './capability/mineralProbeCapability.js';
import { CapabilityPackageRegistry } from './capabilities/capabilityPackageRegistry.js';
import { loadCapabilityResourcePackage } from './capabilities/capabilityManifestLoader.js';
import { createAgricultureCapabilityPackage } from './capabilities/agriculture/agricultureCapabilityPackage.js';
import { createAmbientProactiveCapabilityPackage } from './capabilities/ambient/ambientProactiveCapabilityPackage.js';
import {
  MainBrainProactiveInbox,
  ProactiveCapabilityStateStore,
  ProactiveGoalLeaseRegistry,
  ProactiveIntentArbiter,
  ProactiveTickScheduler,
  formatProactiveRuntimeContext,
  resolveProactiveCapabilityCatalog,
  type ProactiveCapabilityPreferences,
  type RegisteredProactiveTickCapability,
  type ProactiveRuntimeSnapshot,
} from './proactive/index.js';
import { WorldMapStoreImpl, type WorldMapStore } from './infra/worldMapStore.js';
import { WorldMapCollectorImpl, type WorldMapCollector } from './infra/worldMapCollector.js';
import { rankChestTargets } from './task/goalAgent/production/containerTargetResolver.js';
import { installPatchedBlockAt, type PatchStats, type BotBlockAtTarget } from './infra/patchedBlockAt.js';
import { NavFailureFeedback } from './strategy/navFailureFeedback.js';
import { CompanionCore } from './companion/companionCore.js';
import { RunRecorder, type RunSummary, type RunVerdict, type RunTraceEvent } from './bench/runRecorder.js';
import { BenchRunner } from './bench/benchRunner.js';
import { getTestCard, TEST_CARDS, type TestCard } from './bench/cards.js';
import { parseBenchCommand } from './bench/benchCommand.js';
import type { CharacterCardV1 } from '../../character/types.js';
import type { GoalProgressReportLevel } from './decision/goalAgentPort/goalProgressCommunicationGovernor.js';
import { ExecutionFactLog } from './task/execution/executionFactLog.js';
import { TaskRuntimeFactBridge } from './task/execution/taskRuntimeFactBridge.js';

export type PlannerEvolutionMode = 'off' | 'observe' | 'active';
import type { PlannerExperienceBundle, PlannerExperienceFreezeResult } from './task/planner/experience/plannerExperienceProvider.js';
import { RecipeMilestonePlanner } from './task/planner/recipeMilestonePlanner.js';
import type { ExperienceFreezeRequest } from './task/planner/experience/experienceContracts.js';
import type { PlannerPolicyInvalidationV1 } from './task/planner/evolution/plannerEvolutionRuntime.js';
import {
  GoalAgent,
  GoalAgentActionLedger,
  GoalAgentProductionExecutionPort,
  GoalAgentProductionExperiencePort,
  GoalAgentProductionPerceptionPort,
  GoalAgentProductionVerificationPort,
  GoalAgentTaskProjection,
  type GoalAgentLoopEvent,
  type GoalAgentStateV1,
  classifyGoalAgentStatusChange,
  goalAgentTraceInteractionId,
} from './task/goalAgent/index.js';

export interface V2RuntimeConfig {
  game: GameAdapter;
  nav: NavigationAdapter;
  /** FEAT-CROSS-08 · 是否挂载真实游戏身体。false=日常陪聊大脑。 */
  embodied?: boolean;
  /** FEAT-CROSS-08 · 热挂载时实时读取身体状态。 */
  isEmbodied?: () => boolean;
  ownerName: string;
  /** 主人别名列表（游戏 ID / Web 用户名等多身份）· 可选 */
  ownerAliases?: string[];
  /** tick 周期 ms · 默认 200 */
  tickMs?: number;
  /** ⑧ Execute 是否阻塞 · 默认 false（推荐，符合 v2.0 设计） */
  blockingExecute?: boolean;
  /** 是否让任务终态触发 MainBrain 再决策 · 默认 true；隔离评测可关闭 */
  taskFeedbackEnabled?: boolean;
  /** LLM 配置 · 不传则 MainBrain 走 rule-based fallback */
  llm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
    api?: import('../../llm/api.js').LlmApi;
    routeId?: string;
  };
  /** Bot 名 / 性格 · 写进 system prompt */
  botName?: string;
  persona?: string;
  characterCard?: CharacterCardV1;
  /** FEAT-CROSS-18 · 运行时显式覆盖优先于角色卡；缺省 balanced。 */
  progressReportLevel?: GoalProgressReportLevel;
  characterPrompt?: (message: string) => string;
  /** FEAT-CROSS-14 · 只读可信规划经验；空串表示安全降级为无经验。 */
  plannerExperienceContext?: (goalText: string) => string;
  /** FEAT-CROSS-14 · 父 Planner 使用的不可变经验快照。 */
  plannerExperienceSnapshot?: (goalText: string) => PlannerExperienceBundle | null;
  /** Authoritative parent-run freeze. Called only after GoalAgent commits a root goal. */
  plannerExperienceFreeze?: (request: ExperienceFreezeRequest) => PlannerExperienceFreezeResult;
  /** FEAT-CROSS-14 · 执行事实追加日志；经验侧只读消费该文件。 */
  plannerExecutionFactsPath?: string;
  plannerRuntimeDbPath?: string;
  plannerExecutionCodeRevision?: string;
  plannerExecutionConfigRevision?: string;
  /** Cross-loop rollout mode. Every mode still executes leaves through Coordinator. */
  plannerEvolutionMode?: PlannerEvolutionMode;
  /** Safety-only policy invalidations. Normal promote/disable never enters this channel. */
  plannerPolicyInvalidationSubscribe?: (listener: (event: PlannerPolicyInvalidationV1) => void) => () => void;
  /** Candidate experiment accounting observes the authoritative parent PlanRun terminal. */
  plannerPlanTerminalNotify?: (input: {
    planRunId: string;
    outcome: 'succeeded' | 'failed' | 'cancelled';
    detail: string;
  }) => void;
  /** SQLite DB 路径（传入则启用持久化；不传则默认 'data/v2-memory.db'） */
  dbPath?: string;
  /** FEAT-WEBUI-19：Profile 级 LLM 轨迹数据库；缺省跟随 dbPath 目录。 */
  llmTraceDbPath?: string;
  /** WorldMapStore DB 路径（默认 'data/world_map.db'） */
  worldMapDbPath?: string;
  /** Bench Run 轨迹目录；默认跟随 dbPath 所在数据目录。 */
  runsDir?: string;
  /** 固化 Strategy 目录；默认跟随 dbPath 所在数据目录。 */
  strategyDir?: string;
  /** GoalAgent 只读程序性 Skill 目录；默认使用应用内置 skills/。 */
  agentSkillsDir?: string;
  /**
   * BUG-L1-03：提供真实 mineflayer Bot 以便 patchedBlockAt 打到 bot.blockAt。
   * 不传时回退到 GameAdapter 层 patch（兼容测试环境，记忆注入对 pathfinder 无效）。
   */
  getRawBotForPatch?: () => BotBlockAtTarget | null;
  /** 日志回调 · 给 Hub UI / 文件落 */
  onLog?: (level: string, message: string) => void;
  /** Bus 事件回调（前端可用于实时调试） */
  onEvent?: (event: BusEvent) => void;
  /** 日常态 join_game 工具回调。 */
  onJoinGame?: () => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /** FEAT-CROSS-09 · Profile 作用域的独立陪伴核心。未传时按 botName 建立默认核心。 */
  companion?: CompanionCore;
  /** FEAT-MEM-09：纯聊天记忆所属档案，缺省时按机器人身份隔离。 */
  chatProfileId?: string;
  /** FEAT-MEM-09：纯聊天记忆数据库路径。 */
  chatMemoryDbPath?: string;
  /** FEAT-CROSS-13：Profile 作用域的情景记忆数据库路径。 */
  episodeDbPath?: string;
  /** FEAT-CROSS-13：统一记忆只读目录数据库路径。 */
  memoryCatalogPath?: string;
  /** FEAT-CROSS-13：关闭时回退现有 ChatMemory/MemoryV2；默认开启。 */
  memorySystemEnabled?: boolean;
  /** FEAT-CROSS-13：关闭时 GoalAgent 不读取规划记忆视图；默认跟随统一记忆开关。 */
  memoryPlannerViewEnabled?: boolean;
  /** BUG-MEM-20：关闭时禁用本地 Embedding，仅保留 FTS5 检索。缺省开启。 */
  chatMemorySemanticSearch?: boolean;
  /** FEAT-CROSS-12 · 关闭长期记忆时仍保留短期消息，但不自动晋升事实。 */
  chatMemoryAutoCapture?: boolean;
  /** FEAT-MEM-09 · 周期性模型整理独立开关；旧 Profile 缺省开启。 */
  chatMemoryConsolidationEnabled?: boolean;
}

function toLlmTraceJson(value: unknown): LlmTraceJsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as LlmTraceJsonValue;
  } catch {
    return '[unserializable trace payload]';
  }
}

function toLlmTracePayload(value: unknown): Record<string, LlmTraceJsonValue> {
  const cloned = toLlmTraceJson(value);
  return cloned && typeof cloned === 'object' && !Array.isArray(cloned)
    ? cloned as Record<string, LlmTraceJsonValue>
    : { value: cloned };
}

export class V2Runtime {
  readonly bus: EventBusV2;
  /** FEAT-CROSS-04 · 人观测测试台的只读运行轨迹记录器。 */
  readonly benchRecorder: RunRecorder;
  readonly benchRunner: BenchRunner;
  readonly memory: MemoryV2;
  /** FEAT-WEBUI-19：MainBrain/GoalAgent 共用的追加式 LLM 轨迹事实源。 */
  readonly llmTraceStore: LlmTraceEventStore;
  /** FEAT-WEBUI-19：只读查询投影，UI/API 不直接接触事实存储。 */
  readonly llmTraceQuery: LlmTraceQueryService;
  /** FEAT-L7-09 · Hermes 内置记忆（MEMORY.md/USER.md） */
  readonly botMemory: BotMemoryStore;
  /** FEAT-MEM-09 · Profile 隔离的纯聊天分层记忆。 */
  readonly chatMemory: ChatMemoryService;
  /** FEAT-MEM-09 · 默认五分钟一次的自然对话记忆整理；无 LLM 或能力关闭时不创建。 */
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler | null;
  /** FEAT-CROSS-13 · 显著经历的持久化与运行时采集。 */
  readonly episodeStore: EpisodeStore;
  readonly episodeCapture: RuntimeEpisodeCapture;
  readonly memoryCatalog: MemoryCatalog;
  readonly memorySystem: MemorySystem;
  private readonly memorySystemActive: boolean;
  private readonly plannerMemoryActive: boolean;
  /** 纯聊天人格、关系、情绪与主动性核心；不依赖游戏身体。 */
  readonly companion: CompanionCore;
  /** FEAT-NARR-01 · 统一语言中枢 */
  readonly narration: NarrationHub;
  /** FEAT-NARR-01 · 主人最近一次对话时间 · isOwnerActive 用 */
  private lastOwnerChatAt = 0;
  readonly perception: PerceptionPipeline;
  readonly tasks: TaskRuntime;
  readonly supervisor: RuntimeSupervisor;
  readonly mainBrain: MainBrain;
  /** FEAT-L6-04 · 触发器结果记忆（连败退避 + 战后冷却） */
  readonly triggerOutcomes: TriggerOutcomeMemory;
  readonly follow: FollowStrategy;
  readonly reflex: ReflexStrategy;
  readonly farm: FarmStrategy;
  readonly gather: GatherStrategy;
  readonly goto: GotoStrategy;
  readonly provision: ProvisionStrategy;
  readonly survival: SurvivalStrategy;
  readonly escape: EscapeStrategy;
  readonly resolver: ResourceResolver;
  readonly policy: DecisionPolicy;
  readonly heart: Heartbeat;
  readonly body: BodyActionService;
  readonly behaviorRegistry: BehaviorRegistry;
  readonly asyncQueue: AsyncTaskQueue;
  readonly tickRegistry: TickRegistry;
  readonly subtaskInjector: SubtaskInjector;
  goalAgent?: GoalAgent;         // 唯一 GoalAgent：内部 Planner/Actor/Critic/Recovery/Reflection 共享一个 Loop
  strategyStore?: StrategyStore;  // FEAT-CROSS-07 · 固化策略库（fast-path 料）
  readonly goalAgentPort: GoalAgentPort;
  readonly proactiveStateStore: ProactiveCapabilityStateStore;
  readonly proactiveLeases: ProactiveGoalLeaseRegistry;
  readonly proactiveInbox: MainBrainProactiveInbox;
  readonly proactiveScheduler: ProactiveTickScheduler;
  private proactiveCapabilities: readonly RegisteredProactiveTickCapability[] = [];
  private proactivePreferences: ProactiveCapabilityPreferences;
  readonly worldScan: WorldScanCapability;
  readonly mineralProbe: MineralProbeCapability;
  readonly taskRegistry: TaskRegistry;
  readonly worldMap: WorldMapStore;
  readonly worldMapCollector: WorldMapCollector;
  /** FEAT-CROSS-02 · 唯一运动仲裁与执行通道。 */
  readonly navFeedback: NavFailureFeedback;
  private worldMapPatchStats: PatchStats | null = null;
  private worldMapUninstallPatch: (() => void) | null = null;
  /** FEAT-MEM-05 · 位置轨迹采集 timer（30s 间隔） */
  private trajectoryTimer: ReturnType<typeof setInterval> | null = null;
  /** FEAT-MEM-05 · 轨迹采集间隔（可测试覆盖） */
  static readonly TRAJECTORY_INTERVAL_MS = 30_000;

  private running = false;
  private readonly memoryCapabilityEnabled: boolean;
  private memoryConsolidationEnabled: boolean;
  private unsubBusForUi: (() => void) | null = null;
  /** FEAT-L6-04 · death 事件订阅句柄（stop 时解绑） */
  private deathUnsub: (() => void) | null = null;
  private plannerPolicyInvalidationUnsub: (() => void) | null = null;
  private taskRuntimeFactBridge: TaskRuntimeFactBridge | null = null;
  private executionFacts: ExecutionFactLog | null = null;
  private goalAgentTaskProjection: GoalAgentTaskProjection | null = null;
  /** FEAT-CROSS-21 · 完成确认被拒后的重试计数（按 requestId）。 */
  private readonly confirmationRetries = new Map<string, number>();
  private readonly goalAgentTerminalNotifications = new Set<string>();
  private readonly deliveryReceipts:Array<{item:string;count:number;at:number;ref:string}>=[];
  private readonly depositReceipts:Array<{
    item:string;count:number;at:number;position:{x:number;y:number;z:number};ref:string;
  }>=[];
  private readonly placementReceipts:Array<{
    item:string;count:number;at:number;position:{x:number;y:number;z:number};
    relativeTo:'owner'|'self';referencePosition:{x:number;y:number;z:number};referenceYaw?:number;
    relation:'near'|'right'|'front'|'at';ref:string;
  }>=[];
  /** FEAT-CROSS-26-001-004-004 · P3-4 插件内核装配结果（boot 异步；fail-visible 事件同步到 bus）。 */
  private pluginKernelResult: RuntimePluginKernelResult | null = null;
  readonly pluginKernelReady: Promise<RuntimePluginKernelResult> | null;
  /** 已 boot 完成的内核结果（null=未就绪）；仅只读暴露，切换由 P3-4 同一提交完成。 */
  get pluginKernel(): RuntimePluginKernelResult | null { return this.pluginKernelResult; }

  constructor(private readonly cfg: V2RuntimeConfig) {
    const log = (msg: string) => cfg.onLog?.('info', `[v2] ${msg}`);

    this.bus = new EventBusV2();
    this.bus.on('atomic.toss_item.success',event=>{
      const p=event.payload as {item?:string;tossed?:number};
      if(!p.item||typeof p.tossed!=='number'||p.tossed<=0)return;
      this.deliveryReceipts.push({item:p.item,count:p.tossed,at:event.timestamp,ref:event.id});
      if(this.deliveryReceipts.length>100)this.deliveryReceipts.splice(0,this.deliveryReceipts.length-100);
    });
    this.bus.on('atomic.deposit.success',event=>{
      const p=event.payload as {item?:string;moved?:number;pos?:{x:number;y:number;z:number}};
      if(!p.item||typeof p.moved!=='number'||p.moved<=0||!p.pos
        ||![p.pos.x,p.pos.y,p.pos.z].every(Number.isFinite))return;
      this.depositReceipts.push({
        item:p.item,count:p.moved,at:event.timestamp,position:structuredClone(p.pos),ref:event.id,
      });
      if(this.depositReceipts.length>100)this.depositReceipts.splice(0,this.depositReceipts.length-100);
    });
    this.bus.on('behavior.place_relative.success',event=>{
      const p=event.payload as {
        item?:string;count?:number;position?:{x:number;y:number;z:number};
        relativeTo?:'owner'|'self';referencePosition?:{x:number;y:number;z:number};referenceYaw?:number;
        relation?:'near'|'right'|'front'|'at';
      };
      if(!p.item||typeof p.count!=='number'||p.count<=0||!p.position||!p.relativeTo||!p.referencePosition||!p.relation
        ||![p.position.x,p.position.y,p.position.z,p.referencePosition.x,p.referencePosition.y,p.referencePosition.z]
          .every(Number.isFinite))return;
      this.placementReceipts.push({
        item:p.item,count:p.count,at:event.timestamp,position:structuredClone(p.position),
        relativeTo:p.relativeTo,referencePosition:structuredClone(p.referencePosition),relation:p.relation,ref:event.id,
        ...(typeof p.referenceYaw==='number'&&Number.isFinite(p.referenceYaw)?{referenceYaw:p.referenceYaw}:{}),
      });
      if(this.placementReceipts.length>100)this.placementReceipts.splice(0,this.placementReceipts.length-100);
    });
    const runtimeDataDir = dirname(cfg.dbPath ?? 'data/v2-memory.db');
    this.benchRecorder = new RunRecorder(this.bus, cfg.runsDir ?? join(runtimeDataDir, 'runs'));
      this.memory = new MemoryV2(cfg.dbPath);
      const prunedEvents = this.memory.pruneEventsByType(NON_DURABLE_EVENT_TYPES);
      if (prunedEvents > 0) log(`清理 ${prunedEvents} 条非耐久 Heartbeat telemetry`);
      this.companion = cfg.companion ?? new CompanionCore({
        profileId: cfg.botName ?? cfg.ownerName,
        corePersona: {
          id: `core-${cfg.botName ?? cfg.ownerName}`,
          version: 1,
          traits: cfg.persona ? [cfg.persona] : ['平和、诚实、尊重用户边界'],
          boundaries: ['不把推断当作用户事实', '不以依赖或内疚操纵用户'],
        },
      });
    // FEAT-L7-09 · Hermes 内置记忆 · 落在 v2-memory.db 同目录的 memories/
    this.botMemory = new BotMemoryStore(
      { dir: join(dirname(cfg.dbPath ?? 'data/v2-memory.db'), 'memories') },
      (m) => log(`[memory] ${m}`),
    );
    const chatProfileId = cfg.chatProfileId ?? cfg.botName ?? cfg.ownerName;
    const traceProfileFile = chatProfileId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.llmTraceStore = new LlmTraceEventStore({
      profileId: chatProfileId,
      filename: cfg.llmTraceDbPath
        ?? (cfg.dbPath === ':memory:'
          ? ':memory:'
          : join(runtimeDataDir, `llm-traces-${traceProfileFile}.db`)),
    });
    this.llmTraceQuery = new LlmTraceQueryService(this.llmTraceStore);
    this.memoryCapabilityEnabled = cfg.chatMemoryAutoCapture ?? true;
    this.memoryConsolidationEnabled = cfg.chatMemoryConsolidationEnabled ?? true;
    this.chatMemory = new ChatMemoryService({
      profileId: chatProfileId,
      autoCapture: () => this.memoryCapabilityEnabled && (
        !cfg.llm
        || !tuning().memoryConsolidation.enabled
        || !this.memoryConsolidationEnabled
      ),
      embeddingProvider: cfg.chatMemorySemanticSearch === false ? null : new LocalTokenEmbeddingProvider(),
      dbPath: cfg.chatMemoryDbPath ?? join(
        dirname(cfg.dbPath ?? 'data/v2-memory.db'),
        `chat-memory-${chatProfileId.replace(/[^a-zA-Z0-9_-]/g, '_')}.db`,
      ),
    });

    // FEAT-NARR-01 · 统一语言中枢 · 自驱系统的通知经此去重/仲裁/出口，并写入 NoticeLog 供注入大模型上下文
    this.narration = new NarrationHub(
      {
        submitNotice: notice => this.bus.publish('brain.notice', 'suggestion', {
          source: notice.source,
          topic: notice.topic,
          label: notice.label,
          detail: notice.detail,
          status: 'info',
          wake: notice.wake,
          dedupeKey: `narration:${notice.dedupeKey}`,
        }),
        renderer: new TemplateRenderer(),
        isOwnerActive: () => Date.now() - this.lastOwnerChatAt < 15000,
      },
      (m) => log(m),
    );
    this.bus.on('chat.from_owner', () => { this.lastOwnerChatAt = Date.now(); });

    // FEAT-L1-01: 记忆地图 — WorldMapStore + Collector + patchedBlockAt
    const worldMapDbPath = cfg.worldMapDbPath ?? 'data/world_map.db';
    this.worldMap = new WorldMapStoreImpl(worldMapDbPath);
    this.worldMapCollector = new WorldMapCollectorImpl(cfg.game, this.worldMap, {
      intervalMs: 2000,
      minDisplacement: 8,
      // BUG-L5-03 · scanRadius/yRange 改由 tuning().worldScan 控制（可热调），不再在此固定
      onLog: msg => cfg.onLog?.('info', msg),
    });
    // BUG-L1-03: patch 只能打在真实 bot.blockAt 上（让 pathfinder A* 受益）。
    // GameAdapter 没有 blockAt（只有 getBlockAt），不是合法 patch 目标；
    // 未提供 getRawBotForPatch（测试环境）时跳过 patch —— 记忆地图仍照常收集，只是不回填 pathfinder。
    const patchTarget: BotBlockAtTarget | null = cfg.embodied !== false
      ? (cfg.getRawBotForPatch?.() ?? null)
      : null;
    if (patchTarget) {
      const patch = installPatchedBlockAt(patchTarget, this.worldMap, {
        // FEAT-L1-05 · 记忆过期纠错 · diff 检测发 block_changed 事件
        onBlockChanged: diff => {
          this.bus.publish('memory.block_changed', 'info', diff);
        },
        diffCheckIntervalMs: 1000,
      });
      this.worldMapUninstallPatch = patch.uninstall;
      this.worldMapPatchStats = patch.stats;
    } else {
      if (cfg.embodied !== false) log('WorldMap: 无 getRawBotForPatch，跳过 blockAt patch（pathfinder 不吃记忆回填）');
      this.worldMapUninstallPatch = null;
      this.worldMapPatchStats = null;
    }
    log(`WorldMapStore initialized (db=${worldMapDbPath})`);

    // FEAT-L5-01: 寻路失败感知反馈
    this.navFeedback = new NavFailureFeedback(this.bus, cfg.game, undefined, (i) => this.narration.narrate(i));

    // FEAT-CROSS-01 v2: 路径门监视器（门对 pathfinder 透明，DoorMonitor 负责开门）
    // FEAT-CROSS-05: 构造移到 tasks 之后（强制穿门要注册可见任务）
    this.perception = new PerceptionPipeline(cfg.game, this.bus, {
      ownerName: cfg.ownerName,
      ownerAliases: cfg.ownerAliases,
    });
    const episodeDbPath = cfg.episodeDbPath
      ?? (cfg.dbPath === ':memory:'
        ? ':memory:'
        : join(runtimeDataDir, `memory-episodes-${chatProfileId.replace(/[^a-zA-Z0-9_-]/g, '_')}.db`));
    this.episodeStore = new EpisodeStore(episodeDbPath);
    this.episodeCapture = new RuntimeEpisodeCapture({
      profileId: chatProfileId,
      ownerName: cfg.ownerName,
      botName: cfg.botName ?? cfg.ownerName,
      bus: this.bus,
      assembler: new EpisodeAssembler(this.episodeStore),
      world: () => this.perception.getWorldState(),
      onApplied: result => this.bus.publish('memory.episode_applied', 'info', {
        episodeId: result.episode.episodeId,
        kind: result.episode.kind,
        state: result.episode.state,
        created: result.created,
        finalizedNow: result.finalizedNow,
        duplicate: result.duplicate,
        snapshotAdded: result.snapshotAdded,
      }),
    });
    const memoryCatalogPath = cfg.memoryCatalogPath
      ?? (cfg.dbPath === ':memory:'
        ? ':memory:'
        : join(runtimeDataDir, `memory-catalog-${chatProfileId.replace(/[^a-zA-Z0-9_-]/g, '_')}.db`));
    let memoryCatalog: MemoryCatalog;
    let catalogReady = false;
    if (cfg.memorySystemEnabled !== false) {
      try {
        memoryCatalog = new MemoryCatalog(memoryCatalogPath);
        catalogReady = true;
      } catch (error) {
        log(`[memory-system] Catalog 启动失败，已回退现有记忆链：${String(error)}`);
        memoryCatalog = new MemoryCatalog(':memory:');
        this.bus.publish('memory.system_degraded', 'recoverable', { reason: 'catalog_open_failed' });
      }
    } else {
      memoryCatalog = new MemoryCatalog(':memory:');
      this.bus.publish('memory.system_disabled', 'info', { reason: 'feature_flag' });
    }
    this.memoryCatalog = memoryCatalog;
    this.memorySystemActive = cfg.memorySystemEnabled !== false && catalogReady;
    this.plannerMemoryActive = this.memorySystemActive && cfg.memoryPlannerViewEnabled !== false;
    this.memorySystem = new MemorySystem(chatProfileId, this.memoryCatalog, this.episodeStore, {
      liveProviders: [new ChatMemoryRecallProvider(chatProfileId, this.chatMemory)],
      onTrace: trace => this.bus.publish('memory.recall_trace', 'info', {
        traceId: trace.traceId,
        mode: trace.mode,
        candidateCount: trace.candidateCount,
        selectedCount: trace.selected.length,
        droppedCount: trace.dropped.length,
        gapCount: trace.gaps.length,
        budget: trace.budget,
        used: trace.used,
        durationMs: trace.durationMs,
      }),
    });

    // 注册 precondition checkers（业务逻辑，不在框架里）
    const preconditions = new PreconditionRegistry();
    preconditions.register('owner_known', (task, world) => {
      return !!world.owner || !!(task.params.targetPosition || task.params.ownerPosition);
    });
    preconditions.register('owner_known_or_has_position', (task, world) => {
      return !!world.owner || !!(task.params.targetPosition || task.params.ownerPosition);
    });
    preconditions.register('has_seeds', (task, world) => {
      const seed = (task.params.seedName as string) || 'wheat_seeds';
      return world.inventory.items.some(it => it.name === seed && it.count >= 1);
    });
    preconditions.register('has_hoe_with_durability', (task, world) => {
      const hoeName = (task.params.hoeName as string) || 'wooden_hoe';
      const plots = (task.params.plots as number) ?? 1;
      const durPerPlot = (task.params.durabilityPerPlot as number) ?? 1;
      const need = plots * durPerPlot;
      const hoe = world.inventory.items.find(it => it.name === hoeName);
      return !!hoe && (hoe.durability ?? Infinity) >= need;
    });
    // FEAT-L6-04 · 环境类前置门（trigger 与 LLM 立项共用 · OCP：新检查=注册新定义）
    // no_hostiles_nearby：16 格内存在敌对实体 → 拒绝（防出门送死）
    preconditions.register('no_hostiles_nearby', (_task, world) => {
      const R = tuning().l6.hostileRadius;
      return !world.entities.some(e => e.category === 'hostile' && e.distance <= R);
    });
    // safe_daytime：夜里 → 拒绝（统一 T-GATHER-WOOD 原 ad-hoc isDay 口径）
    preconditions.register('safe_daytime', (_task, world) => world.environment.isDay);

    // FEAT-L6-03 · Critic 提前实例化，作为 complete() 后置验证门注入 TaskRuntime（验证器在下方注册区注册）
    const criticRegistry = new CriticRegistry();
    const ruleCritic = new RuleCritic();

    this.tasks = new TaskRuntime(
      this.memory,
      this.bus,
      preconditions,
      ruleCritic,                              // FEAT-L6-03 · complete() 后置验证门
      () => this.perception.getWorldState(),   // 实时世界视图（避免快照过期误杀）
    );
    if (cfg.plannerExecutionFactsPath) {
      this.executionFacts = new ExecutionFactLog({
        filePath: cfg.plannerExecutionFactsPath,
        codeRevision: cfg.plannerExecutionCodeRevision ?? 'local-dev',
        configRevision: cfg.plannerExecutionConfigRevision ?? 'default',
      });
      this.taskRuntimeFactBridge = new TaskRuntimeFactBridge(
        this.bus,
        this.tasks,
        this.executionFacts,
      );
    }
    // TaskRegistry · 加载任务定义
    this.taskRegistry = new TaskRegistry();
    this.taskRegistry.loadAll(join(__dirname, 'knowledge/tasks'));

    this.supervisor = new RuntimeSupervisor(
      this.bus,
      this.memory,
      this.tasks,
      this.perception,
    );
    this.follow = new FollowStrategy();
    this.reflex = new ReflexStrategy(this.tasks);
    this.farm = new FarmStrategy(this.bus, this.tasks);
    this.gather = new GatherStrategy(cfg.game, this.bus, this.tasks);
    this.goto = new GotoStrategy(this.bus, this.tasks);
    this.provision = new ProvisionStrategy(cfg.game, this.bus, this.tasks);
    this.survival = new SurvivalStrategy(this.tasks);
    this.escape = new EscapeStrategy(cfg.game, this.tasks);
    // One assembly list feeds heartbeat and discovery; a YAML class name cannot register a strategy.
    const taskStrategies = [this.escape, this.follow, this.farm, this.gather, this.goto, this.provision];
    const autoDefenseStrategies = [this.survival];
    this.resolver = new ResourceResolver();
    this.resolver.register(new InventoryProvider());
    this.resolver.register(new CraftProvider());
    this.resolver.register(new ChestMemoryProvider(this.memory));
    this.policy = new DecisionPolicy();
    this.behaviorRegistry = new BehaviorRegistry();
    this.behaviorRegistry.register(new FollowBehavior());
    this.behaviorRegistry.register(new FarmBehavior());
    this.behaviorRegistry.register(new CombatBehavior());
    this.behaviorRegistry.register(new FleeBehavior());
    this.behaviorRegistry.register(new GatherBehavior());
    this.behaviorRegistry.register(new CraftBehavior());
    this.behaviorRegistry.register(new ChestWithdrawBehavior());
    this.behaviorRegistry.register(new DepositToChestBehavior());
    this.behaviorRegistry.register(new DeliverToOwnerBehavior());
    this.behaviorRegistry.register(new PlaceRelativeBehavior());
    this.behaviorRegistry.register(new PickupGroundItemBehavior());
    this.asyncQueue = new AsyncTaskQueue();
    this.tickRegistry = new TickRegistry();
    this.proactiveStateStore = new ProactiveCapabilityStateStore();
    this.proactiveLeases = new ProactiveGoalLeaseRegistry();
    this.proactivePreferences = cfg.characterCard?.performance.proactiveCapabilities ?? {};
    // FEAT-MEM-06 · 传 bus 给 WorldScan 订阅 atomic.deposit.success/withdraw.success 写箱子索引
    this.worldScan = new WorldScanCapability(cfg.game, this.memory, undefined, this.bus);
    // FEAT-L2-02 · MineralProbe 与 WorldScan 并列（独立周期把矿物方块沉淀进 spatial）
    this.mineralProbe = new MineralProbeCapability(cfg.game, this.memory);
    this.subtaskInjector = new SubtaskInjector(this.tasks, this.bus);
    // Critic（US-E3）· 框架只提供注册能力，业务逻辑在这里注册
    // FEAT-L6-03 · criticRegistry / ruleCritic 已在 TaskRuntime 构造前实例化（见上），此处仅注册验证器

    // 注册 follow_owner 验证
    ruleCritic.registerVerifier('follow_owner', (task, _before, after) => {
      const owner = after.owner;
      if (!owner) {
        const hasTarget = !!(task.params.targetPosition || task.params.ownerPosition);
        if (hasTarget) return makeVerdict(task, 'partial', 'seeking target position');
        return makeVerdict(task, 'unknown', 'owner not visible');
      }
      // owner 不可见（坐矿车 / 超出渲染距离）→ seeking 中，不是 failure
      if (!owner.isVisible || !isFinite(owner.distance)) {
        return makeVerdict(task, 'partial', 'seeking: owner out of range');
      }
      // follow_owner 是持续性任务 · 到达 = partial（正常工作中），不是 success
      // success 会被 Heartbeat Critic 步骤调 complete()，持续性任务不应自动结束
      if (owner.distance <= 3) return makeVerdict(task, 'partial', `in range: ${owner.distance.toFixed(1)}`);
      return makeVerdict(task, 'partial', `moving: dist=${owner.distance.toFixed(1)}`);
    });

    // 注册 farm 验证
    ruleCritic.registerVerifier('farm', (task, before, after) => {
      // FEAT-L7-05：continuous 模式 = 持续任务，永远 partial，不自动 complete
      if ((task.params.mode as string) === 'continuous') {
        const harvest = (task.progress?.totalHarvest as number) ?? 0;
        const done = (task.progress?.plotsDone as number) ?? 0;
        return makeVerdict(task, 'partial', `continuous · plots=${done} · harvest=${harvest}`);
      }
      const seed = (task.params.seedName as string) || 'wheat_seeds';
      const countItem = (w: typeof before, n: string) =>
        w.inventory.items.filter(it => it.name === n).reduce((s, it) => s + it.count, 0);
      const seedsBefore = countItem(before, seed);
      const seedsAfter = countItem(after, seed);
      const seedsUsed = seedsBefore - seedsAfter;
      const expectedPlots = (task.params.plots as number) ?? 1;
      const progress = (task.progress?.plotsDone as number) ?? 0;
      if (progress >= expectedPlots) return makeVerdict(task, 'success', `done: ${progress}/${expectedPlots}`);
      if (seedsUsed >= expectedPlots) return makeVerdict(task, 'success', `planted all: ${seedsUsed}/${expectedPlots}`);
      if (seedsUsed > 0) return makeVerdict(task, 'partial', `planted ${seedsUsed}/${expectedPlots}`);
      return makeVerdict(task, 'fail', `no progress: seeds=${seedsBefore}→${seedsAfter}`);
    });

    // ── FEAT-L6-03 · 后置验证器（防假成功）· 只看 after 世界视图 ──────────────
    // 阶段二：声明式 postconditions —— gather_material / craft_item 等写 yaml 即得验证门（OCP）。
    // taskRegistry 已在上方 loadAll，遍历注册；新任务类型加 yaml 即生效，无需改本文件。
    for (const def of this.taskRegistry.listAll()) {
      if (def.postconditions?.length) {
        ruleCritic.registerPostcondition(def.kind, buildPostconditionFn(def.postconditions));
      }
    }

    // guard：警戒区敌对未清的断言非"库存"类，保留手写（阶段二可扩 no_hostiles 断言类型再声明化）
    // 警戒半径内仍有敌对实体 → fail（怪没清策略却想退出=假成功）；清空 → partial（持续守卫，不自动完成）
    ruleCritic.registerPostcondition('guard', (task, after) => {
      const center = task.params.center as { x: number; y: number; z: number } | undefined;
      const radius = Number(task.params.radius ?? 16);
      const hostiles = after.entities.filter(e => {
        if (e.category !== 'hostile') return false;
        if (!center) return true; // 无中心点则只要视野内有敌对就算威胁未清
        const dx = e.position.x - center.x, dy = e.position.y - center.y, dz = e.position.z - center.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
      });
      return hostiles.length > 0
        ? makeVerdict(task, 'fail', `false_success: 警戒区内仍有 ${hostiles.length} 个敌对实体`, { hostiles: hostiles.length })
        : makeVerdict(task, 'partial', '警戒区已清空（持续守卫中）');
    });

    // goto_position（FEAT-L7-12 / GYM-BUG-04）：到达即终态 success，防"没到就报到"假成功。
    // 水平距 ≤ arriveDist → success；否则 fail（complete() 误触发也会被这门拦下）。
    ruleCritic.registerPostcondition('goto_position', (task, after) => {
      const tp = (task.params.targetPosition ?? task.params.position) as { x: number; y: number; z: number } | undefined;
      if (!tp || typeof tp.x !== 'number' || typeof tp.z !== 'number') {
        return makeVerdict(task, 'fail', 'goto_position 缺 targetPosition');
      }
      const me = after.self.position;
      const dx = tp.x - me.x, dz = tp.z - me.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      return d <= tuning().goto.arriveDist
        ? makeVerdict(task, 'success', `arrived: dist=${d.toFixed(1)}`)
        : makeVerdict(task, 'fail', `false_success: 还差 ${d.toFixed(1)} 格没到`, { dist: Math.round(d) });
    });

    criticRegistry.register(ruleCritic);

    // LLM 客户端（FEAT-L7-07：Hermes 子进程层移除，LLM 直驱）
    let llmClient: LLMClient | null = null;
    if (cfg.llm) {
      llmClient = new LLMClient(
        cfg.llm,
        (cat, msg) => cfg.onLog?.('info', `[llm:${cat}] ${msg}`),
        { traceRecorder: this.llmTraceStore },
      );
    }
    this.memoryConsolidationScheduler = this.memoryCapabilityEnabled && llmClient
      ? new MemoryConsolidationScheduler(
        new ChatMemoryConsolidator(this.chatMemory, new LLMMemoryFactExtractor(llmClient)),
        {
          getConfig: () => ({
            ...tuning().memoryConsolidation,
            enabled: tuning().memoryConsolidation.enabled && this.memoryConsolidationEnabled,
          }),
          log: message => log(`[memory] ${message}`),
        },
      )
      : null;

    // FEAT-L6-04 · 触发器结果记忆 · 订阅任务终态维护连败退避；IDLE trigger 立项前咨询
    this.triggerOutcomes = new TriggerOutcomeMemory();
    this.bus.on('task.completed', ev => {
      const p = ev.payload as { taskId?: string };
      if (p.taskId) this.triggerOutcomes.noteTerminal(p.taskId, 'completed');
    });
    this.bus.on('task.failed', ev => {
      const p = ev.payload as { taskId?: string; code?: string; detail?: string };
      if (p.taskId) {
        this.triggerOutcomes.noteTerminal(p.taskId, {
          code: (p.code as FailureCode) ?? 'unknown',
          detail: p.detail,
        });
      }
    });

    // FEAT-CROSS-06b · goal 求解系统总开关：需 LLM（rule 已退役，无 LLM 则整套 goal 系统禁用）+ tuning 启用。
    const goalSystemOn = !!llmClient && tuning().goalAgent.enabled;
    // One catalog instance is shared by cognitive discovery and real dispatch.
    const capabilityRouter = new GoalCapabilityRouter();
    // FEAT-CROSS-07 · 固化策略库提前建好（供主脑 manage_strategy 工具 + goal 求解器 fast-path 共用）
    if (goalSystemOn && tuning().strategy.enabled) {
      this.strategyStore = new StrategyStore(cfg.strategyDir ?? join(runtimeDataDir, 'strategies'), () => Date.now(), (m) => log(m));
    }
    this.body = new BodyActionService({
      game:cfg.game,nav:cfg.nav,registry:this.behaviorRegistry,bus:this.bus,tasks:this.tasks,
      getWorld:()=>this.perception.getWorldState() ?? this.perception.perceive(),
      isEmbodied:()=>this.isEmbodied(),
      getGoalState:sessionId=>this.goalAgent?.snapshot(sessionId) ?? null,
    });

    if (goalSystemOn && llmClient) {
      const profileId = cfg.plannerExecutionConfigRevision ?? cfg.botName ?? 'default';
      const profileFile = profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const actionLedger = new GoalAgentActionLedger(join(runtimeDataDir, `goal-agent-actions-${profileFile}.db`));
      this.goalAgentTaskProjection = new GoalAgentTaskProjection(this.tasks);
      const agentSkillRegistry = new AgentSkillRegistry(message => log(message));
      agentSkillRegistry.loadLocalDir(cfg.agentSkillsDir ?? join(__dirname, '../../../skills'));
      const goalToolNames = new GoalAgentRoundToolRuntime({ profileId, tools: {} }).names();
      const skillKnowledge = new GoalAgentSkillKnowledgeAdapter(agentSkillRegistry, () => goalToolNames);
      for (const skill of skillKnowledge.catalog({ limit: 64 })) {
        if (skill.toolCompatibility?.state === 'unsupported_tools') {
          log(`[v2][capabilities] Skill ${skill.name} references unsupported tools: ${skill.toolCompatibility.missingTools.join(', ')}`);
        }
      }
      const agricultureResources = loadCapabilityResourcePackage(
        join(__dirname, '../../../capability-packages/agriculture'),
      );
      // BUG-CROSS-80 · 配方知识与执行层同源：从 getCraftRecipes/getItemSource 生成领域知识文档。
      // 生成依赖 bot.registry（mineflayer 连接后才有），故延迟到 onSpawn 时注入；
      // 初始 registry 只装能力包 Markdown（农业），bot 上线后 addAll 配方知识（幂等）。
      const domainKnowledge = new DomainKnowledgeRegistry(agricultureResources.knowledgeDocuments);
      const recipeKnowledgeItems = DEFAULT_GOAL_TARGETS
        .filter(target => target.kind === 'item' && target.registryId.startsWith('minecraft:'))
        .map(target => ({
          id: target.registryId.replace(/^minecraft:/, ''),
          aliases: target.aliases,
        }));
      const attachRecipeKnowledge = (): void => {
        try {
          const documents = buildRecipeKnowledgeDocuments({
            items: recipeKnowledgeItems,
            data: {
              getCraftRecipes: (item, withTable) => cfg.game.getCraftRecipes(item, withTable),
              getItemSource: item => cfg.game.getItemSource(item),
            },
          });
          const added = domainKnowledge.addAll(documents);
          if (added > 0) {
            log(`[v2][knowledge] recipe knowledge attached: ${added} documents`);
          }
        } catch (error) {
          log(`[v2][knowledge] recipe knowledge attach failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      // bot 上线/spawn 时注入；死亡重生重复触发时 addAll 幂等跳过已存在 id。
      cfg.game.onSpawn(() => attachRecipeKnowledge());
      const capabilityPackages = new CapabilityPackageRegistry({
        atomicIds: createDefaultAtomicContractRegistry().list().map(value => value.action),
        behaviorIds: this.behaviorRegistry.list().map(value => value.id),
        strategyIds: this.strategyStore?.usable().map(value => value.id) ?? [],
        skillNames: agentSkillRegistry.list()
          .filter(value => value.meta.agent !== 'main' && (value.meta.uses ?? []).every(name => goalToolNames.includes(name)))
          .map(value => value.meta.name),
        knowledgeIds: domainKnowledge.ids(),
        goalTargetIds: DEFAULT_GOAL_TARGETS.map(value => value.registryId),
        taskKinds: this.taskRegistry.listAll().map(value => value.kind),
      });
      capabilityPackages.register(createAgricultureCapabilityPackage({
        game: cfg.game,
        manifest: agricultureResources.manifest,
        resolveChestTargets: (requestText, world) => {
          const positions = cfg.game.findBlocks({ names: ['chest', 'trapped_chest'], maxDistance: 32, count: 12 });
          return rankChestTargets(positions, requestText, world);
        },
      }));
      capabilityPackages.register(createAmbientProactiveCapabilityPackage());
      const capabilitySnapshot = capabilityPackages.snapshot();
      const goalDraftCompiler = new GoalDraftCompiler({
        predicates: () => capabilitySnapshot.predicateEvaluators,
        bindings: state => capabilitySnapshot.goalBindingProviders.flatMap(provider => [...provider.list(state)]),
      });
      const goalPlanAuthority = new GoalPlanAuthority({ snapshot: () => capabilitySnapshot, bindings: state => goalDraftCompiler.bindings(state) });
      this.proactiveCapabilities = capabilitySnapshot.proactiveTicks;
      for (const behavior of capabilitySnapshot.behaviors) this.behaviorRegistry.register(behavior);
      const goalKnowledge = new InMemoryGoalKnowledgePort([
        ...DEFAULT_GOAL_TARGETS,
        ...capabilitySnapshot.goalTargets,
      ]);
      const executionPort = new GoalAgentProductionExecutionPort({
        game:cfg.game,bus:this.bus,body:this.body,
        getWorld:()=>this.perception.getWorldState() ?? this.perception.perceive(),
        behaviors: this.behaviorRegistry,
        tasks: this.tasks,
        parentTaskId: sessionId => this.goalAgentTaskProjection?.rootTaskId(sessionId) ?? null,
        resolveGatherTargets: (item, world) => {
          const source = cfg.game.getItemSource(item);
          if (!source) return [];
          try {
            return cfg.game.findBlocks({ names: source.block, maxDistance: 64, count: 4 }).map(pos => ({
              pos,
              blockName: source.block,
              ...(source.requiredTool ? { toolName: source.requiredTool } : {}),
            }));
          } catch {
            return [];
          }
        },
        resolveChestTargets: (_item, _count, requestText, world) => {
          try {
            const positions = cfg.game.findBlocks({ names: ['chest', 'trapped_chest'], maxDistance: 32, count: 12 });
            return rankChestTargets(positions, requestText, world);
          } catch {
            return [];
          }
        },
        ...(this.strategyStore ? { strategyStore: this.strategyStore } : {}),
        categorizeTarget: (bind, world) => this.categorizeTarget(bind, world),
        actionLedger,
        actionProviders: capabilitySnapshot.actionProviders,
        operations: capabilitySnapshot.operations,
        plans: goalPlanAuthority,
        log,
      });
      const experiencePort = new GoalAgentProductionExperiencePort(
        request => cfg.plannerEvolutionMode === 'active' && cfg.plannerExperienceFreeze
          ? cfg.plannerExperienceFreeze({
              planRunId: request.planRunId,
              goalSignature: request.goalSignature,
              context: request.context,
              mode: 'production',
            })
          : {
              status: 'cold_start',
              reason: 'no_applicable_experience',
              selectionManifest: {
                id: `manifest:${request.planRunId}:off`,
                planRunId: request.planRunId,
                query: {
                  goalSignature: request.goalSignature.key,
                  contextSignatureHash: 'planner_mode_not_active',
                },
                selected: [],
                rejected: [],
              },
            },
        proposal => this.bus.publish('goalagent.experience.proposed', 'info', proposal as unknown as Record<string, unknown>),
      );
      this.goalAgent = new GoalAgent({
        profileId,
        stateDbPath: join(runtimeDataDir, `goal-agent-${profileFile}.db`),
        modelClient: llmClient,
        skillKnowledge,
        domainKnowledge,
        capabilityKnowledge: createRuntimeCapabilityKnowledge(() => ({
          snapshot: capabilitySnapshot, routes: capabilityRouter.list(),
          atomics: createDefaultAtomicContractRegistry().list(), behaviors: this.behaviorRegistry.list(),
          executionSupport: [
            ...createDefaultAtomicContractRegistry().list().map(value=>({kind:'atomic' as const,id:value.action})),
            ...this.behaviorRegistry.list().map(value=>({kind:'behavior' as const,id:value.id})),
          ].map(value=>({...value,controlledCancellation:this.body.supports({ref:{id:`${value.kind}:${value.id}`,contribution:{pluginId:'mineclaw.legacy-builtin',pluginVersion:'1.0.0',contributionId:`${value.kind}:${value.id}`,contributionVersion:'1.0.0'}},args:{}})})),
          tasks: this.taskRegistry.listAll(),
          strategies: [...taskStrategies, this.reflex, ...autoDefenseStrategies].map(value => ({
            id: value.id, name: value.constructor.name, kind: value.kind,
          })),
          services: [
            { id: this.worldScan.id, name: 'WorldScanCapability', summary: '周期扫描世界、地形与容器；写入空间记忆，不是直接模型工具。' },
            { id: this.mineralProbe.id, name: 'MineralProbeCapability', summary: '周期探测矿物并写入空间记忆；不是 find_mineral 工具。' },
          ],
          adapters: [
            { id: 'GameAdapter', summary: 'Injected game interface; actual body binding is checked at execution, never a direct model tool.' },
            { id: 'NavigationAdapter', summary: 'Injected navigation interface used by movement execution; never a direct model tool.' },
          ],
          dataStrategies: this.strategyStore?.usable().map(value => ({ id: value.id, description: value.description })) ?? [],
        })),
        planMilestones: new RecipeMilestonePlanner({
          getCraftRecipes: (item, withTable) => cfg.game.getCraftRecipes(item, withTable),
          getItemSource: item => cfg.game.getItemSource(item),
        }),
        tools: {
          knowledge: goalKnowledge,
          execution: executionPort,
          goals: goalDraftCompiler,
          plans: goalPlanAuthority,
          progress: new CapabilityProgressPolicy(() => capabilitySnapshot),
          experience: experiencePort,
          perception: new GoalAgentProductionPerceptionPort(() => this.perception.perceive(), () => capabilitySnapshot.worldFactProviders),
          verification: new GoalAgentProductionVerificationPort(
            () => this.deliveryReceipts,
            () => this.depositReceipts,
            () => this.placementReceipts,
            () => capabilitySnapshot.predicateEvaluators,
          ),
          ...(this.memorySystemActive
            ? { memory: new GoalAgentMemoryKnowledgeAdapter(this.memorySystem) }
            : {}),
        },
        budget: {
          maxLlmCalls: tuning().goalAgent.maxRoundsPerGoal,
          maxTotalTokens: tuning().goalAgent.maxTotalTokensPerGoal,
          maxActions: tuning().goalAgent.maxActionsPerGoal,
          maxRecoveries: tuning().goalAgent.maxAttempt,
          maxGraphReplans: Math.max(2, tuning().goalAgent.maxAttempt),
        },
        maxRoundsPerRun: tuning().goalAgent.maxRoundsPerRun,
        getGamePresence: () => gamePresenceFromWorld(
          this.isEmbodied(),
          this.perception.getWorldState(),
        ),
        getProactiveCapabilitiesContext: () => this.getProactiveCapabilitiesContext(),
        publishEvent: event => {
          this.recordGoalAgentTrace(event);
          this.recordGoalAgentFact(event);
          this.bus.publish(event.type, event.type.includes('failed') ? 'recoverable' : 'info', {
            sessionId: event.sessionId,
            revision: event.revision,
            epoch: event.epoch,
            phase: event.phase,
            node: event.node,
            ...event.payload,
          });
        },
        publishReport: report => this.bus.publish(
          'goalagent.report',
          report.status === 'failed' ? 'recoverable' : 'info',
          report as unknown as Record<string, unknown>,
        ),
        onState: state => {
          if (state.mode === 'planned_goal') this.goalAgentTaskProjection?.update(state);
          this.notifyGoalAgentTerminal(state);
        },
        disposeTools:()=>actionLedger.close(),
        log,
      });
    }
    this.plannerPolicyInvalidationUnsub = cfg.plannerPolicyInvalidationSubscribe?.(event => {
      const affectedGoalSessions = this.goalAgent?.cancelAll(`planner_policy_invalidated:${event.reason}`) ?? 0;
      this.bus.publish('planner.policy.invalidated', 'critical', { ...event, affectedGoalSessions });
    }) ?? null;

    const capabilityDispatcher = new GoalCapabilityDispatcher(capabilityRouter);
    const publishCapabilityReport = (
      request: GoalRequestV2,
      status: GoalReportV2['status'],
      summary: string,
      runtimeRef: string,
    ): void => {
      const observedAt = new Date().toISOString();
      const report: GoalReportV2 = {
        meta: {
          ...request.meta,
          messageId: `goal-report-${randomUUID()}`,
          causationId: request.meta.messageId,
          sequence: request.meta.sequence + 1,
          emittedAt: observedAt,
          idempotencyKey: `${request.meta.correlationId}:${status}:${runtimeRef}`,
        },
        requestId: request.meta.messageId,
        status,
        summary,
        evidence: [{ type: 'action_result', ref: `task:${runtimeRef}:${status}`, observedAt }],
      };
      this.bus.publish('goalagent.report', status === 'failed' ? 'recoverable' : 'info', report as unknown as Record<string, unknown>);
    };
    const unavailableSnapshot = (probe: GoalStatusProbeV2, stage: string): GoalStatusSnapshotV2 => ({
      sessionId: probe.sessionId,
      requestId: probe.requestId,
      state: 'unknown',
      stage,
      evidence: [],
      observedAt: new Date().toISOString(),
    });
    const persistentWorldEvidenceRefs = (world: WorldStateView | null): string[] => {
      if (!world) return [];
      const bucket = (value: number): number => Math.round(value / 2) * 2;
      const refs = [
        `bot-position:${bucket(world.self.position.x)}:${bucket(world.self.position.z)}`,
      ];
      if (world.owner?.position) {
        refs.push(`owner-position:${bucket(world.owner.position.x)}:${bucket(world.owner.position.z)}`);
      }
      if (world.owner && Number.isFinite(world.owner.distance)) {
        refs.push(`owner-distance:${bucket(world.owner.distance)}`);
      }
      return refs;
    };
    const goalAgentHandler = {
      submit: (request: GoalRequestV2) => this.goalAgent?.submit(request) ?? ({
        accepted: false,
        reason: 'goal_agent_unavailable',
      }),
      inspect: (probe: GoalStatusProbeV2) => this.goalAgent?.inspect(probe) ?? unavailableSnapshot(
        probe,
        'goal_agent_unavailable',
      ),
    };
    for (const handlerId of ['production_planner_gateway', 'goal_agent.query']) {
      capabilityDispatcher.register(handlerId, goalAgentHandler);
    }
    capabilityDispatcher.register('goal_agent.cancel', {
      submit: request => {
        const runtimeRef = `cancel-${request.meta.messageId}`;
        const cancelled = this.cancelActiveTasks(`owner_cancel:${request.requestText.slice(0, 96)}`);
        publishCapabilityReport(request, 'completed', `已停止 ${cancelled} 条活动执行。`, runtimeRef);
        return { accepted: true, details: { runtimeRef, cancelled } };
      },
      inspect: (probe, record) => ({
        sessionId: probe.sessionId,
        requestId: probe.requestId,
        state: 'completed',
        stage: 'cancel_completed',
        runtimeRef: record.runtimeRef,
        evidence: [],
        observedAt: new Date().toISOString(),
      }),
    });
    capabilityDispatcher.register('task_runtime.follow_owner', {
      submit: (request, match) => {
        const world = this.perception.getWorldState();
        if (!world) return { accepted: false, reason: 'follow_owner_world_unavailable' };
        if (!world.owner) return { accepted: false, reason: 'follow_owner_target_unavailable' };
        const task = this.tasks.createFollowOwnerTask({ ownerName: world.owner.username || this.cfg.ownerName });
        const started = this.tasks.start(task.id, world);
        if (!started.ok) {
          this.tasks.cancel(task.id, started.reason ?? 'follow_owner_start_failed');
          return { accepted: false, reason: started.reason ?? 'follow_owner_start_failed' };
        }
        const monitor = this.goalAgent?.startPersistentMonitor(request, {
          world,
          runtimeRef: task.id,
          evidenceRefs: [
            `task:${task.id}:running`,
            ...persistentWorldEvidenceRefs(world),
          ],
        });
        if (this.goalAgent && !monitor?.accepted) {
          this.tasks.cancel(task.id, monitor?.reason ?? 'goal_agent_monitor_start_failed');
          return { accepted: false, reason: monitor?.reason ?? 'goal_agent_monitor_start_failed' };
        }
        publishCapabilityReport(
          request,
          'running',
          `已开始持续跟随主人，当前距离 ${world.owner.distance.toFixed(1)} 格。`,
          task.id,
        );
        return {
          accepted: true,
          details: {
            runtimeRef: task.id,
            taskId: task.id,
            capabilityId: match.definition.id,
            ownerDistance: world.owner.distance,
            ...(monitor?.details?.sessionId ? { monitorSessionId: monitor.details.sessionId } : {}),
          },
        };
      },
      inspect: (probe, record) => {
        const runtimeRef = record.runtimeRef ?? '';
        const task = runtimeRef ? this.tasks.getById(runtimeRef) : null;
        if (!task) return unavailableSnapshot(probe, 'follow_owner_task_not_found');
        const state: GoalStatusSnapshotV2['state'] = task.state === 'pending'
          ? 'queued'
          : task.state === 'running'
            ? 'executing'
            : task.state === 'paused'
              ? 'blocked'
              : task.state === 'failed'
                ? 'failed'
                : 'completed';
        const observedAt = new Date().toISOString();
        const world = this.perception.getWorldState();
        return {
          sessionId: probe.sessionId,
          requestId: probe.requestId,
          state,
          stage: `follow_owner:${task.state}`,
          runtimeRef,
          ...(task.startedAt ? { lastProgressAt: new Date(task.startedAt).toISOString() } : {}),
          ...(task.state === 'failed' && task.failure
            ? { blocker: `${task.failure.code}:${task.failure.detail ?? ''}` }
            : {}),
          ...(task.state === 'running' ? { nextAction: 'continue_following_owner' } : {}),
          evidence: [
            { type: 'action_result', ref: `task:${runtimeRef}:${task.state}`, observedAt },
            ...persistentWorldEvidenceRefs(world).map(ref => ({ type: 'world_snapshot' as const, ref, observedAt })),
          ],
          observedAt,
        };
      },
    });
    const publishRoutedTaskTerminal = (
      payload: unknown,
      status: Extract<GoalReportV2['status'], 'completed' | 'failed' | 'cancelled'>,
    ): void => {
      const value = payload as { taskId?: string; reason?: string; detail?: string };
      if (!value.taskId) return;
      const record = capabilityDispatcher.findByRuntimeRef(value.taskId);
      if (!record) return;
      const detail = value.detail ?? value.reason;
      const monitorSessionId = typeof record.details.monitorSessionId === 'string'
        ? record.details.monitorSessionId
        : null;
      if (monitorSessionId) {
        void this.goalAgent?.finishPersistentMonitor(
          monitorSessionId,
          status,
          detail ?? `persistent capability ${status}`,
          [`task:${value.taskId}:${status}`],
        ).catch(error => {
          this.bus.publish('goalagent.monitor.terminal_failed', 'recoverable', {
            monitorSessionId,
            runtimeRef: value.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      publishCapabilityReport(
        record.request,
        status,
        status === 'cancelled'
          ? `已停止持续能力：${record.definition.id}。`
          : status === 'completed'
            ? `持续能力已完成：${record.definition.id}。`
            : `持续能力失败：${record.definition.id}${detail ? ` · ${detail}` : ''}`,
        value.taskId,
      );
    };
    this.bus.on('task.completed', event => publishRoutedTaskTerminal(event.payload, 'completed'));
    this.bus.on('task.failed', event => publishRoutedTaskTerminal(event.payload, 'failed'));
    this.bus.on('task.cancelled', event => publishRoutedTaskTerminal(event.payload, 'cancelled'));

    this.goalAgentPort = new GoalAgentPort(this.bus, this.perception, {
      submit: request => capabilityDispatcher.submit(request),
      cancelRequest: (requestId, reason) => {
        const record = capabilityDispatcher.findByRequestId(requestId);
        let accepted = this.goalAgent?.cancelRequest(requestId, reason) ?? false;
        if (record?.runtimeRef) {
          const task = this.tasks.getById(record.runtimeRef);
          if (task && !['completed', 'failed', 'cancelled'].includes(task.state)) {
            this.tasks.cancel(task.id, reason);
            accepted = true;
          }
        }
        return accepted;
      },
    }, undefined, undefined, {
      inspector: { inspect: probe => capabilityDispatcher.inspect(probe) },
      isPersistentRequest: request =>
        capabilityDispatcher.findByRequestId(request.meta.messageId)?.definition.mode === 'persistent_behavior',
      onSnapshot: observation => {
        const record = capabilityDispatcher.findByRequestId(observation.request.meta.messageId);
        const monitorSessionId = typeof record?.details.monitorSessionId === 'string'
          ? record.details.monitorSessionId
          : null;
        if (!monitorSessionId || record?.definition.mode !== 'persistent_behavior') return;
        const change = classifyGoalAgentStatusChange(
          observation.previousSnapshot,
          observation.snapshot,
        );
        void this.goalAgent?.monitorPersistent({
          sessionId: monitorSessionId,
          source: 'watchdog',
          change,
          summary: `persistent ${record.definition.id}: ${observation.snapshot.state}${observation.snapshot.stage ? ` (${observation.snapshot.stage})` : ''}`,
          evidenceRefs: observation.snapshot.evidence.map(item => item.ref),
        }).catch(error => {
          this.bus.publish('goalagent.monitor.failed', 'recoverable', {
            monitorSessionId,
            runtimeRef: record.runtimeRef,
            change,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    }, {
      level: cfg.progressReportLevel ?? cfg.characterCard?.performance.progressReportLevel ?? 'balanced',
    }, {
      // FEAT-CROSS-21 · 完成确认闸：completed 必须先过机器复核（收据/fresh 实物）
      getCriteria: sessionId => this.goalAgent?.getRootCriteria(sessionId) ?? null,
      getWorld: () => this.perception.getWorldState(),
      getEvidence: () => ({
        deliveries: [...this.deliveryReceipts],
        deposits: [...this.depositReceipts],
        placements: [...this.placementReceipts],
      }),
      confirm: input => confirmCompletion(input),
      onRejected: input => {
        log(`[goalagent] confirmation rejected: ${input.reason} · ${input.detail}`);
        // 同请求重试一次（新建会话继承上下文并携带拒绝证据），防无限重试走 tuning 上限
        const retries = this.confirmationRetries.get(input.requestId) ?? 0;
        if (retries >= tuning().goalAgent.confirmationRetryLimit) {
          this.bus.publish('goalagent.confirmation_exhausted', 'recoverable', input);
          return;
        }
        this.confirmationRetries.set(input.requestId, retries + 1);
        try {
          this.goalAgentPort?.retryRequest(input.requestId, `（重试：上次完成声明未通过复核：${input.detail}，请真实交付后完成）`);
        } catch (error) {
          log(`[goalagent] confirmation retry failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    this.bus.on('goalagent.confirmed', event => {
      const payload = event.payload as { sessionId?: string; requestId?: string };
      if (payload.sessionId) this.goalAgentTaskProjection?.markConfirmed(payload.sessionId);
    });
    this.proactiveInbox = new MainBrainProactiveInbox({
      goalAgentPort: this.goalAgentPort,
      leases: this.proactiveLeases,
      stateStore: this.proactiveStateStore,
      publish: (type, payload) => this.bus.publish(type, 'info', payload),
    });
    this.proactiveScheduler = new ProactiveTickScheduler({
      profileId: cfg.chatProfileId ?? cfg.botName ?? 'default',
      capabilities: this.proactiveCapabilities,
      preferences: this.proactivePreferences,
      stateStore: this.proactiveStateStore,
      arbiter: new ProactiveIntentArbiter(),
      leases: this.proactiveLeases,
      isForegroundBusy: () => {
        if (this.proactiveLeases.snapshot().active) return false;
        return this.tasks.list().some(task => task.state === 'running' || task.state === 'paused');
      },
      onArbitration: (decision, evaluations) => {
        for (const [capabilityId, evaluation] of evaluations) {
          this.bus.publish('proactive.evaluated', 'info', {
            capabilityId,
            kind: evaluation.kind,
            ...(evaluation.kind === 'idle' || evaluation.kind === 'release' ? { reason: evaluation.reason } : {}),
            ...(evaluation.kind === 'candidate' ? {
              requestText: evaluation.candidate.requestText,
              evidenceRefs: evaluation.candidate.evidenceRefs,
            } : {}),
          });
        }
        for (const suppression of decision.suppressions) {
          this.bus.publish('proactive.suppressed', 'info', suppression);
        }
        this.bus.publish('proactive.arbitrated', 'info', {
          kind: decision.kind,
          capabilityId: 'winner' in decision ? decision.winner.capabilityId : undefined,
        });
        this.proactiveInbox.handle(decision, evaluations);
      },
    });
    this.goalAgentPort.setPlayerTurnPreemptor(() => { this.proactiveInbox.preemptForPlayer(); });
    this.tickRegistry.register(this.proactiveScheduler);
    const brainDeps = {
      onBenchCommand: (message: string) => this.handleBenchCommand(message),
      isBenchActive: () => this.benchRunner?.active() != null,
      onOwnerCancellation: (message: string) => this.cancelActiveTasks(`owner_cancel:${message.slice(0, 64)}`),
      bus: this.bus,
      triggerOutcomes: this.triggerOutcomes,
      game: cfg.game,
      ownerName: cfg.ownerName,
      goalAgentPort: this.goalAgentPort,
      memory: this.memory, // FEAT-MEM-02/03：位置记忆与自我定位工具用
      botMemory: this.botMemory, // FEAT-L7-09 · Hermes 内置记忆
      chatMemory: this.chatMemory, // FEAT-MEM-09 · 纯聊天分层记忆
      memorySystem: this.memorySystemActive ? this.memorySystem : undefined, // FEAT-CROSS-13 · 可灰度回滚
      companion: this.companion,
      narration: this.narration, // FEAT-NARR-01 · 近期通知注入 LLM 上下文
      llm: llmClient,
      llmTraceRecorder: this.llmTraceStore,
      getProactiveCapabilitiesContext: () => this.getProactiveCapabilitiesContext(),
      asyncQueue: this.asyncQueue,
      embodied: cfg.embodied !== false,
      isEmbodied: cfg.isEmbodied,
      getGamePresence: () => gamePresenceFromWorld(
        this.isEmbodied(),
        this.perception.getWorldState(),
      ),
      getRunningTaskCount: () => this.tasks.list().filter(t => t.state === 'running' || t.state === 'paused').length,
      getActiveTask: () => {
        const activeTask = this.tasks.active();
        return activeTask ? {
          id: activeTask.id,
          kind: activeTask.kind,
          state: activeTask.state,
          params: activeTask.params,
        } : null;
      },
    };
    this.mainBrain = new MainBrain(
      brainDeps,
      {
        ownerName: cfg.ownerName,
        botName: cfg.botName,
        persona: cfg.persona,
        characterCard: cfg.characterCard,
        characterPrompt: cfg.characterPrompt,
        taskFeedbackEnabled: cfg.taskFeedbackEnabled,
        onLog: log,
      },
    );

    const hbCfg: HeartbeatConfig = {
      tickMs: cfg.tickMs ?? 200,
      blockingExecute: cfg.blockingExecute ?? false,
    };
    this.heart = new Heartbeat(hbCfg, {
      bus: this.bus,
      memory: this.memory,
      perception: this.perception,
      tasks: this.tasks,
      supervisor: this.supervisor,
      reflex: this.reflex,
      taskStrategies,
      autoDefenseStrategies,
      isAutomaticDefenseEnabled: () => tuning().defense.automaticEnabled,
      body: this.body,
      asyncQueue: this.asyncQueue,
      tickRegistry: this.tickRegistry,
      critic: criticRegistry,
      isEmbodied: () => this.isEmbodied(),
    });
    this.benchRunner = new BenchRunner({
      bus: this.bus,
      recorder: this.benchRecorder,
      setup: command => { if (this.isEmbodied()) this.cfg.game.chat(command); },
      submitAction: request => this.heart.submitRequest(request),
      createTask: (kind, params) => this.tasks.createTask(kind, params, { label: `TestBench:${kind}`, priority: 55 }),
      startTask: taskId => this.tasks.start(taskId, this.perception.getWorldState() ?? this.perception.perceive()),
      judge: (card, events) => this.judgeBenchCard(card, events),
    });

    // TickRegistry · 按节拍等级注册各模块
    //   Reflex         → FAST  (每 tick   · 紧急反应  · 主路径走 Heartbeat ④)
    //   Follow / Farm  → STD   (每 5 tick · 常规策略  · 主路径走 Heartbeat ⑥)
    //   Supervisor     → SLOW  (每 10tick · watchdog  · 在节拍内调 watchdog)
    //   idle_placeholder → IDLE (每 150tick · 预留 GC/snapshot)
    const _supervisor = this.supervisor;
    this.tickRegistry.register({
      id: 'reflex',
      rate: TickRate.FAST,
      onTick: () => { /* Reflex 主路径走 Heartbeat ④ · 节拍感知占位 */ },
    });
    this.tickRegistry.register({
      id: 'follow_strategy',
      rate: TickRate.STD,
      onTick: () => { /* FollowStrategy 主路径走 Heartbeat ⑥ · 节拍感知占位 */ },
    });
    this.tickRegistry.register({
      id: 'farm_strategy',
      rate: TickRate.STD,
      onTick: () => { /* FarmStrategy 主路径走 Heartbeat ⑥ · 节拍感知占位 */ },
    });
    this.tickRegistry.register({
      id: 'supervisor_watchdog',
      rate: TickRate.SLOW,
      onTick: ctx => { _supervisor.watchdog(ctx.tick); },
    });
    this.tickRegistry.register({
      id: 'idle_placeholder',
      rate: TickRate.IDLE,
      onTick: () => { /* IDLE ~30s 低频占位 · 后续接内存 GC / 离线 snapshot */ },
    });
    // BUG-CROSS-01 修③ · 持续任务徒劳检测 · SLOW 节拍
    // 判定：follow_owner 运行中 + 策略处于 lost/seeking + bot 位移 < moveEpsilon 持续 stallMs
    // → 发 task.futile + 通知 MainBrain（修④放行 IDLE，escalate 唤醒慢脑告知主人）。
    // in_range（到位站桩）属合法静止，不计入。阈值全走 tuning().futility（铁律）。
    const futilityState = { sinceMs: 0, anchor: null as { x: number; y: number; z: number } | null, flaggedTaskId: '' };
    this.tickRegistry.register({
      id: 'futility_watch',
      rate: TickRate.SLOW,
      onTick: () => {
        const fut = tuning().futility;
        const t = this.tasks.active();
        // 恢复进展（位移/状态变化/任务结束）→ 撤销标记，同任务再卡死可重新标记
        const reset = () => {
          futilityState.sinceMs = 0;
          futilityState.anchor = null;
          if (futilityState.flaggedTaskId) {
            this.mainBrain.clearFutileTask(futilityState.flaggedTaskId);
            futilityState.flaggedTaskId = '';
          }
        };
        if (!t || t.kind !== 'follow_owner' || t.state !== 'running') { reset(); return; }
        const view = this.follow.inspect().view as { state?: string };
        if (view.state !== 'lost' && view.state !== 'seeking') { reset(); return; }
        const pos = cfg.game.getPosition();
        if (!futilityState.anchor) {
          futilityState.anchor = { ...pos };
          futilityState.sinceMs = Date.now();
          return;
        }
        const dx = pos.x - futilityState.anchor.x, dz = pos.z - futilityState.anchor.z;
        if (Math.sqrt(dx * dx + dz * dz) > fut.moveEpsilon) { reset(); return; }   // 有位移 = 有进展
        const stalled = Date.now() - futilityState.sinceMs;
        if (stalled >= fut.stallMs && futilityState.flaggedTaskId !== t.id) {
          futilityState.flaggedTaskId = t.id;
          this.bus.publish('task.futile', 'recoverable', { taskId: t.id, kind: t.kind, state: view.state, stalledMs: stalled });
          this.mainBrain.noteFutileTask({ taskId: t.id, kind: t.kind, stalledMs: stalled });
          log(`[futility] ${t.kind}(${t.id}) ${view.state} 态 ${Math.round(stalled / 1000)}s 零位移 → 标记徒劳 · 唤醒慢脑`);
        }
      },
    });

    // WorldScan · SLOW 节拍 · 周期扫描方块/实体 → 写入 Memory.spatial / objects
    this.tickRegistry.register(this.worldScan);
    // FEAT-L2-02 · MineralProbe · SLOW 节拍 · 周期扫描矿物方块 → 写 Memory.spatial(kind=resource, meta.mineralType)
    this.tickRegistry.register(this.mineralProbe);

    // 让 Supervisor 能通过 Heartbeat 提交 say · 给玩家做 narration
    this.supervisor.attachNarrationSink({
      submitSay: (source, text, priority) => this.heart.submitSay(source, text, priority),
      narrate: (intent) => this.narration.narrate(intent),
    });
    // FEAT-NARR-01 · 让 Heartbeat 每 tick 收敛通知意图
    this.heart.attachNarration(this.narration);

    // 注入 SubtaskInjector（setter 方式，避免破坏 Supervisor 构造签名）
    this.supervisor.setInjector(this.subtaskInjector);

    // Auto-archive all bus events to memory (non-blocking · US-C4)
    this.bus.onAny(ev => {
      if (!isDurableEventType(ev.type)) return;
      this.memory.scheduleCommit('event', {
        id: `${ev.type}-${ev.timestamp}-${ev.id}`,
        type: ev.type,
        level: ev.level,
        payload: ev.payload,
        timestamp: ev.timestamp,
      });
    });

    // 把 Bus 事件转给 UI 回调
    if (cfg.onEvent) {
      this.unsubBusForUi = this.bus.onAny(cfg.onEvent);
    }
    // 关键日志
    this.bus.on('l7.turn_started', () => log('L7 turn 开始'));
    this.bus.on('l7.tool_use', ev =>
      log(`L7 tool=${(ev.payload as { name: string }).name}`),
    );
    this.bus.on('task.started', ev =>
      log(`L6 task started: ${(ev.payload as { kind: string }).kind}`),
    );
    // FEAT-L6-04 · 终态可观测：每个任务从 started 到终态必有一行终态日志
    this.bus.on('task.completed', ev =>
      log(`L6 task completed: ${(ev.payload as { kind: string }).kind}`),
    );
    this.bus.on('task.failed', ev => {
      const p = ev.payload as { kind?: string; code?: string; detail?: string };
      log(`L6 task failed: ${p.kind ?? '?'} · ${p.code ?? 'unknown'}${p.detail ? ' · ' + p.detail : ''}`);
    });
    this.bus.on('task.paused', ev =>
      log(`L6 task paused: ${JSON.stringify(ev.payload)}`),
    );
    this.bus.on('task.resumed', ev =>
      log(`L6 task resumed: ${JSON.stringify(ev.payload)}`),
    );
    this.bus.on('supervisor.task_suspended_by_danger', () =>
      log('🛡 Supervisor 暂停任务（遇袭）'),
    );
    this.bus.on('supervisor.task_resumed', () =>
      log('🛡 Supervisor 恢复任务（危险解除）'),
    );
    // FEAT-CROSS-01 v2: DoorMonitor 关键日志
    this.bus.on('door.detected', ev => {
      const p = ev.payload as { pos: { x: number; y: number; z: number }; block: string; state: string };
      log(`[DoorMonitor] 检测到关闭门 ${p.block}@${p.pos.x}:${p.pos.y}:${p.pos.z}`);
    });
    this.bus.on('door.opened', ev => {
      const p = ev.payload as { pos: { x: number; y: number; z: number }; block: string; reason: string };
      log(`[DoorMonitor] 开门成功 ${p.block}@${p.pos.x}:${p.pos.y}:${p.pos.z} reason=${p.reason}`);
    });
    this.bus.on('door.open_failed', ev => {
      const p = ev.payload as { pos: { x: number; y: number; z: number }; block: string; reason: string };
      log(`[DoorMonitor] 开门失败 ${p.block}@${p.pos.x}:${p.pos.y}:${p.pos.z} reason=${p.reason}`);
    });
    this.bus.on('door.blocked', ev => {
      const p = ev.payload as { pos: { x: number; y: number; z: number }; type: string };
      log(`[DoorMonitor] 铁门不可开 ${p.type}@${p.pos.x}:${p.pos.y}:${p.pos.z}`);
    });
    // 已废除 door.force_walk；DoorMonitor 单次开门后由 NavigationAdapter 门事务完成亚方块穿越。

    // 采集 / 合成 / 卡死恢复 关键日志
    this.bus.on('gather.progress', ev => {
      const p = ev.payload as { material: string; have: number; count: number; done?: boolean };
      log(`[Gather] ${p.material} ${p.have}/${p.count}${p.done ? ' ✓完成' : ''}`);
    });
    this.bus.on('provision.subtask', ev => {
      const p = ev.payload as { parent: string; kind: string; material?: string; item?: string };
      log(`[Provision] 派生子任务 ${p.kind} ${p.material ?? p.item ?? ''}`);
    });
    this.bus.on('provision.done', ev => {
      const p = ev.payload as { item: string; count: number };
      log(`[Provision] 完成 ${p.item}×${p.count} ✓`);
    });
    this.bus.on('atomic.craft.success', ev => {
      const p = ev.payload as { item: string; count: number };
      log(`[Craft] 合成成功 ${p.item}×${p.count}`);
    });
    this.bus.on('atomic.craft.fail', ev => {
      const p = ev.payload as { item: string; error?: string };
      log(`[Craft] 合成失败 ${p.item} · ${p.error ?? ''}`);
    });
    this.bus.on('stuck.recovery', ev => {
      const p = ev.payload as { stage: number; action: string };
      log(`[Stuck] 脱困 stage${p.stage} action=${p.action}`);
    });
    this.bus.on('navigation.stuck_unrecovered', () => log('[Stuck] 多次脱困无效，上报'));

    // FEAT-L1-05 · 记忆过期纠错 · diff 事件日志
    this.bus.on('memory.block_changed', ev => {
      const p = ev.payload as { position: { x: number; y: number; z: number }; previousBlockName: string; actualBlockName: string };
      log(`[block_changed] ${p.previousBlockName} → ${p.actualBlockName} @${p.position.x},${p.position.y},${p.position.z}`);
    });

    // FEAT-L3-01 · 逃跑已由 ReflexStrategy → FleeSkill 正式接管
    // 原 BUG-L7-02 盲跑桩已删除

    // ── 心跳管线关键日志 ──────────────────────────────────────────
    this.bus.on('arbitrate.result', ev => {
      const p = ev.payload as {
        winners?: { source: string; type: string; priority: number }[];
        rejected?: { source: string; type: string; priority: number; reason: string }[];
      };
      if (p.winners?.length) {
        log(`⑦ winners=[${p.winners.map(w => `${w.source}/${w.type}(P${w.priority})`).join(', ')}]`);
      }
      if (p.rejected?.length) {
        log(`⑦ rejected=[${p.rejected.map(r => `${r.source}/${r.type}→${r.reason}`).join(', ')}]`);
      }
    });
    this.bus.on('exec.success', ev => {
      const p = ev.payload as { source: string; type: string; durationMs: number };
      log(`⑧ exec OK · ${p.source}/${p.type} (${p.durationMs}ms)`);
    });
    this.bus.on('exec.fail', ev => {
      const p = ev.payload as { source: string; type: string; durationMs: number; error?: string };
      log(`⑧ exec FAIL · ${p.source}/${p.type} (${p.durationMs}ms) · ${p.error ?? '?'}`);
    });
    this.bus.on('heartbeat.executing_watchdog', ev => {
      const p = ev.payload as { tick: number; stuckMs: number; req: string };
      log(`⚠️ executing watchdog · stuck ${p.stuckMs}ms · req=${p.req} · 强制重置`);
    });

    // FEAT-CROSS-26-001-004-004 · P3-4 第 1 步：装配插件内核（生成索引 + world/设备端口注入）。
    // boot 异步且 fail-visible：结果同步到 bus 事件与日志，切换提交前不阻断既有启动路径。
    const runtimeGetWorld = () => this.perception.getWorldState() ?? this.perception.perceive();
    const observationPorts = createRuntimeObservationPorts(runtimeGetWorld);
    this.pluginKernelReady = buildRuntimePluginKernel({
      buildId: `runtime-${cfg.botName ?? 'mineclaw'}-${process.pid}`,
      systemPorts: {
        game: cfg.game,
        nav: cfg.nav,
        bus: this.bus,
        getWorld: runtimeGetWorld,
        inventoryObservation: observationPorts.inventory,
        ownerContextObservation: observationPorts.owner,
        ...(llmClient ? { llm: llmClient } : {}),
      },
    });
    void this.pluginKernelReady.then(result => {
      this.pluginKernelResult = result;
      this.bus.publish('plugin.kernel.status', result.ok ? 'info' : 'recoverable', {
        ok: result.ok,
        installed: result.installed.length,
        failures: result.failures,
      });
      log(result.ok
        ? `[plugin-kernel] 就绪 · ${result.installed.length} 个插件已发布`
        : `[plugin-kernel] boot 失败: ${result.failures.join('; ') || 'unknown'}`);
    });
  }

  /** 目标安全归类（matcher 安全闸用）：owner/friendly/hostile_entity/player */
  private categorizeTarget(bind: Record<string, unknown>, world: import('./types.js').WorldStateView | null): string[] {
    const t = bind.target;
    if (t == null || !world) return [];
    if (world.owner && (String((world.owner as { entityId?: unknown }).entityId) === String(t) || (world.owner as { username?: string }).username === String(t))) return ['owner'];
    const ent = (world.entities ?? []).find(e => String(e.id) === String(t) || e.name === String(t));
    if (!ent) return [];
    if (ent.name === this.cfg.ownerName) return ['owner'];
    const cat = (ent as { category?: string }).category;
    const labels: string[] = [];
    if (cat === 'hostile') labels.push('hostile_entity');
    if (cat === 'player') labels.push('player');
    return labels.length ? labels : ['other'];
  }

  private notifyGoalAgentTerminal(state: Readonly<GoalAgentStateV1>): void {
    if (state.mode !== 'planned_goal' || !state.terminal || state.request.requestKind !== 'task') return;
    const key = `${state.sessionId}:${state.epoch}:${state.terminal.outcome}`;
    if (this.goalAgentTerminalNotifications.has(key)) return;
    this.goalAgentTerminalNotifications.add(key);
    const outcome = state.terminal.outcome === 'completed'
      ? 'succeeded' as const
      : state.terminal.outcome === 'timed_out'
        ? 'failed' as const
        : state.terminal.outcome;
    this.cfg.plannerPlanTerminalNotify?.({
      planRunId: state.sessionId,
      outcome,
      detail: state.terminal.summary,
    });
  }

  private recordGoalAgentFact(event: GoalAgentLoopEvent): void {
    if (!this.executionFacts) return;
    const state = this.goalAgent?.snapshot(event.sessionId);
    const roundTools = goalAgentRoundToolNames(event.payload);
    const eventType = event.type === 'goalagent.session.created'
      ? 'execution.session.started'
      : event.type === 'goalagent.session.terminal'
        ? 'execution.session.terminal'
        : event.type === 'goalagent.round.completed' && roundTools.includes('action_execute')
          ? 'execution.action.completed'
          : event.type === 'goalagent.round.completed'
          ? 'execution.progress.observed'
          : 'execution.state.changed';
    this.executionFacts.append({
      sessionId: event.sessionId,
      runId: event.sessionId,
      planRunId: event.sessionId,
      planRevision: state?.plan.revision ?? 0,
      nodeId: state?.plan.activeNodeId ?? event.node,
      correlationId: state?.request.meta.correlationId ?? event.sessionId,
    }, eventType, {
      goalAgentEvent: event.type,
      revision: event.revision,
      epoch: event.epoch,
      phase: event.phase,
      node: event.node,
      ...event.payload,
    });
  }

  private recordGoalAgentTrace(event: GoalAgentLoopEvent): void {
    if (event.type === 'goalagent.model.called') return;
    const state = this.goalAgent?.snapshot(event.sessionId);
    const base = {
      occurredAt: state?.updatedAt ?? new Date().toISOString(),
      correlationId: state?.request.meta.correlationId ?? event.sessionId,
      interactionSessionId: state ? goalAgentTraceInteractionId(state) : undefined,
      goalSessionId: event.sessionId,
      taskId: state?.requestId,
      agent: 'goalagent' as const,
      node: event.node,
      stateRevision: event.revision,
      epoch: event.epoch,
    };
    const append = (
      type: LlmTraceEventType,
      payload: Record<string, LlmTraceJsonValue>,
      node: string = event.node,
    ) => {
      try {
        this.llmTraceStore.append({ ...base, type, node, payload });
      } catch (error) {
        this.cfg.onLog?.('error', `[llm:trace] GoalAgent event append failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
      }
    };
    const payload = toLlmTracePayload({
      goalAgentEvent: event.type,
      phase: event.phase,
      revision: event.revision,
      epoch: event.epoch,
      ...event.payload,
    });
    if (event.type === 'goalagent.session.created') {
      append('agent.node.entered', payload);
      return;
    }
    if (event.type === 'goalagent.round.completed') {
      const roundTools = goalAgentRoundToolNames(event.payload);
      append('agent.node.exited', payload, 'round');
      append('agent.node.entered', payload, 'round');
      if (roundTools.includes('world_observe') && state?.world.latest) {
        append('world.observed', toLlmTracePayload({
          evidenceRefs: event.payload.evidenceRefs ?? [],
          observedAt: state.world.observedAt,
          inventory: state.world.latest.inventory,
        }), 'round');
      }
      if ((roundTools.includes('progress_verify') || roundTools.includes('action_execute')) && state?.verdict) {
        append('verdict.recorded', toLlmTracePayload(state.verdict), 'round');
      }
      return;
    }
    if (event.type === 'goalagent.monitor.observation_refreshed') {
      append('world.observed', payload, event.node);
      return;
    }
    if (event.type === 'goalagent.session.terminal') {
      if (state?.verdict) append('verdict.recorded', toLlmTracePayload(state.verdict), 'round');
      append('session.terminal', toLlmTracePayload({
        outcome: state?.terminal?.outcome ?? event.payload.outcome ?? event.phase,
        summary: state?.terminal?.summary ?? event.payload.summary ?? '',
        evidenceRefs: state?.terminal?.evidenceRefs ?? event.payload.evidenceRefs ?? [],
      }), 'terminal');
      return;
    }
    if (event.type === 'goalagent.round.failed') append('agent.node.exited', payload, 'round');
  }

  /**
   * 为真实游戏身体安装统一的生产导航策略。
   * 冷启动和 Companion→Game 热挂载必须共用此入口，避免首次导航继承
   * mineflayer-pathfinder 的 canDig=true 默认值而破坏门或场景。
   */
  private configureEmbodiedNavigation(): void {
    this.cfg.nav.setMovementOptions({
      canDig: false,
      canPlace: true,
      canOpenDoors: false,
      allowParkour: true,
      allowSprinting: true,
      scafoldingBlocks: ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack'],
    });
  }

  getProactiveRuntimeSnapshot(): ProactiveRuntimeSnapshot {
    return Object.freeze({
      catalog: resolveProactiveCapabilityCatalog(this.proactiveCapabilities, this.proactivePreferences),
      states: this.proactiveStateStore.snapshot(),
      lease: this.proactiveLeases.snapshot(),
    });
  }

  getProactiveCapabilitiesContext(): string {
    return formatProactiveRuntimeContext(this.getProactiveRuntimeSnapshot());
  }

  setProactiveCapabilityPreferences(preferences: ProactiveCapabilityPreferences): void {
    // Scheduler validates the full update before the live preference reference changes.
    this.proactiveScheduler.setPreferences(preferences);
    this.proactivePreferences = structuredClone(preferences);
    this.bus.publish('proactive.preferences.updated', 'info', {
      capabilityIds: Object.keys(preferences).sort(),
    });
  }

  getMemoryConsolidationCapability(): MemoryConsolidationCapabilitySnapshot {
    const schedulerStatus = this.memoryConsolidationScheduler?.status();
    const available = this.memoryCapabilityEnabled && this.memoryConsolidationScheduler !== null;
    if (!this.memoryCapabilityEnabled) {
      return Object.freeze({
        id: 'memory_consolidation',
        label: '定时记忆整理',
        description: '每 5 分钟自动识别并整理对话中的长期关键信息。',
        enabled: this.memoryConsolidationEnabled,
        defaultEnabled: true,
        available: false,
        state: 'unavailable',
        statusLabel: '长期记忆能力未启用',
      });
    }
    if (!available) {
      return Object.freeze({
        id: 'memory_consolidation',
        label: '定时记忆整理',
        description: '每 5 分钟自动识别并整理对话中的长期关键信息。',
        enabled: this.memoryConsolidationEnabled,
        defaultEnabled: true,
        available: false,
        state: 'unavailable',
        statusLabel: '未配置可用的 LLM',
      });
    }
    if (!this.memoryConsolidationEnabled) {
      return Object.freeze({
        id: 'memory_consolidation',
        label: '定时记忆整理',
        description: '每 5 分钟自动识别并整理对话中的长期关键信息。',
        enabled: false,
        defaultEnabled: true,
        available: true,
        state: 'disabled',
        statusLabel: '未启用',
      });
    }
    if (!tuning().memoryConsolidation.enabled) {
      return Object.freeze({
        id: 'memory_consolidation',
        label: '定时记忆整理',
        description: '每 5 分钟自动识别并整理对话中的长期关键信息。',
        enabled: true,
        defaultEnabled: true,
        available: true,
        state: 'idle',
        statusLabel: '已被运行时调参暂停',
      });
    }
    const inFlight = schedulerStatus?.inFlight === true;
    return Object.freeze({
      id: 'memory_consolidation',
      label: '定时记忆整理',
      description: '每 5 分钟自动识别并整理对话中的长期关键信息。',
      enabled: true,
      defaultEnabled: true,
      available: true,
      state: inFlight ? 'running' : 'idle',
      statusLabel: inFlight ? '正在整理' : '已启用 · 每 5 分钟',
    });
  }

  setMemoryConsolidationEnabled(enabled: boolean): MemoryConsolidationCapabilitySnapshot {
    this.memoryConsolidationEnabled = enabled;
    if (this.running && enabled) this.memoryConsolidationScheduler?.start();
    else if (!enabled) this.memoryConsolidationScheduler?.stop();
    this.bus.publish('memory.consolidation.preference.updated', 'info', { enabled });
    return this.getMemoryConsolidationCapability();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const embodied = this.isEmbodied();
    this.cfg.onLog?.('info', `[v2] runtime starting (${embodied ? 'embodied' : 'companion'})`);

    if (embodied) {
      // 移动能力配置
      // BUG-CROSS-08：DoorMonitor 是木门唯一物理交互者；Pathfinder 只负责
      // 规划到门中央，关闭门禁止 diagonal 以避免撞到旋转后的门板。
      // FEAT-L1-02: canPlace=true + scafoldingBlocks → 允许垫方块过坑/垫高路
      //   pathfinder 只在背包里有这些方块时才会规划「搭桥/垫高」节点
      this.configureEmbodiedNavigation();

      // FEAT-L6-04 · 死亡联动：death → 当前 running 任务 fail(died) + 战后全局冷却 5min（防死亡螺旋）
      this.deathUnsub = this.cfg.game.onDeath(() => {
        const pos = this.cfg.game.getPosition?.() ?? null;
        this.bus.publish('bot.death', 'recoverable', { position: pos });
        const active = this.tasks.active();
        if (active) {
          this.tasks.fail(active.id, { code: 'died', detail: 'bot 死亡掉落物品' });
        }
        const deathCd = tuning().l6.deathCooldownMs;
        this.triggerOutcomes.blockAll(deathCd, '战后冷却（死亡联动）');
        this.cfg.onLog?.('info', `[v2] 💀 death → ${active ? `任务 ${active.kind} 转 failed(died)` : '无活跃任务'} · 外勤 trigger 冷却 ${Math.round(deathCd / 1000)}s`);
      });
    }

    this.heart.start();
    if (this.memoryConsolidationEnabled) this.memoryConsolidationScheduler?.start();
    if (embodied) {
      // FEAT-L1-01: 启动地形采集
      this.worldMapCollector.start();
      // FEAT-L5-01: 启动寻路失败感知反馈
      this.navFeedback.start();
      // FEAT-MEM-05: 启动位置轨迹采集
      this.startTrajectoryRecording();
    }
    this.bus.publish('runtime.started', 'info', {});
    // US-C2: 恢复上次中断的 paused 任务。日常陪聊态不恢复身体任务，避免无身体误执行。
    if (embodied) this.supervisor.hydrate();
    if (embodied) this.goalAgent?.restore();
  }

  /**
   * 确定性取消所有上层目标、任务与在途运动。
   * 主人紧急停止和 Benchmark case 隔离会同时终结持久化 PlanRun；
   * 进程停止/身体掉线只暂停执行面，保留 PlanRun 供下次恢复。
   */
  cancelActiveTasks(
    reason = 'cancelled_by_owner',
    options: { preservePlanRuns?: boolean } = {},
  ): number {
    this.mainBrain.cancelTaskContext(reason);
    this.heart.cancelBodyActions();
    // Heartbeat and GoalAgent share the same body runtime; cancellation does not release its lease.
    this.follow.reset();
    const cancelledGoalSessions = options.preservePlanRuns
      ? 0
      : (this.goalAgent?.cancelAll(reason) ?? 0);

    const active = this.tasks.list().filter(task =>
      task.state === 'pending' || task.state === 'running' || task.state === 'paused');
    for (const task of active) this.tasks.cancel(task.id, reason);
    return active.length + cancelledGoalSessions;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.memoryConsolidationScheduler?.stop();
    this.taskRuntimeFactBridge?.close();
    this.taskRuntimeFactBridge = null;
    this.plannerPolicyInvalidationUnsub?.();
    this.plannerPolicyInvalidationUnsub = null;
    // BUG-CROSS-32：先冻结所有大脑输入/输出，再取消下游任务。
    // 否则 task.cancelled 等终止事件会把已停止的 MainBrain 再次唤醒。
    this.mainBrain.shutdown('runtime_stopped');
    this.goalAgentPort.shutdown();
    if (this.benchRunner.active()) this.benchRunner.abort('runtime_stopped');
    this.cancelActiveTasks('runtime_stopped', { preservePlanRuns: true });
    this.goalAgent?.close();
    this.asyncQueue.close({ dropPending: true });
    this.heart.stop();
    this.body.close();
    // FEAT-L1-01: 停止采集 + 卸载 patch + 关闭 DB
    this.worldMapCollector.stop();
    // FEAT-L5-01: 停止寻路失败感知反馈
    this.navFeedback.stop();
    // FEAT-MEM-05: 停止位置轨迹采集
    this.stopTrajectoryRecording();
    this.worldMapUninstallPatch?.();
    this.worldMap.close();
    this.chatMemory.close();
    this.episodeCapture.stop();
    this.episodeStore.close();
    this.memoryCatalog.close();
    this.llmTraceStore.close();
    this.supervisor.shutdown();
    // BUG-CROSS-42：Runtime 拥有 MemoryV2 生命周期，停止时必须释放 SQLite 连接。
    this.memory.close();
    this.deathUnsub?.();
    this.deathUnsub = null;
    this.unsubBusForUi?.();
    this.bus.publish('runtime.stopped', 'info', {});
    this.cfg.onLog?.('info', '[v2] runtime stopped');
  }

  /** 真实游戏身体已挂载到 Switchable adapter 后调用；不重建 Companion Core/MainBrain。 */
  attachBody(): void {
    if (!this.running) return;
    // BUG-CROSS-37：SwitchableNavAdapter 已切到真实 Nav；必须先装安全 Movements，
    // 再恢复任何会启动导航的采集器/任务。
    this.configureEmbodiedNavigation();
    this.worldMapCollector.start();
    this.navFeedback.start();
    this.startTrajectoryRecording();
    this.supervisor.hydrate();
    this.goalAgent?.restore();
    this.bus.publish('runtime.body_attached', 'info', {});
  }

  /** 游戏身体卸载后调用；保留对话、记忆、人格与关系状态。 */
  detachBody(): void {
    this.cancelActiveTasks('game_body_detached', { preservePlanRuns: true });
    this.worldMapCollector.stop();
    this.navFeedback.stop();
    this.stopTrajectoryRecording();
    this.bus.publish('runtime.body_detached', 'info', {});
  }

  private isEmbodied(): boolean {
    return this.cfg.isEmbodied ? this.cfg.isEmbodied() : this.cfg.embodied !== false;
  }

  /**
   * Web UI / 外部直聊注入 · 当作 owner 直接对 bot 说话处理。
   * 经 MainBrain.handleDirectMessage 跳过 AddressDetector + owner 判定。
   */
  injectOwnerChat(message: string): void {
    this.mainBrain.handleDirectMessage(message);
  }

  notifyBrain(input: { source: string; topic: string; label: string; detail?: string; wake?: boolean }): void {
    this.bus.publish('brain.notice', 'suggestion', { ...input, status: 'info' });
  }

  private handleBenchCommand(message: string): boolean {
    const command = parseBenchCommand(message);
    if (command.kind === 'not_bench') return false;
    if (!tuning().testBench.enabled) {
      this.heart.submitSay('bench', '测试台默认关闭；开发时可在 data/tuning.json 中开启 testBench.enabled。');
      return true;
    }
    if (command.kind === 'list') {
      this.heart.submitSay('bench', `可用测试：${TEST_CARDS.map(card => card.id).join('、')}`);
      return true;
    }
    if (command.kind === 'abort') {
      const result = this.benchRunner.abort();
      this.heart.submitSay('bench', result ? `已中止测试 ${result.cardId}` : '当前没有运行中的测试');
      return true;
    }
    if (command.kind === 'error') {
      this.heart.submitSay('bench', command.message);
      return true;
    }
    const card = getTestCard(command.cardId)!;
    void this.benchRunner.start(card)
      .then(() => this.heart.submitSay('bench', `开始测试 ${card.id}（${card.tier}）`))
      .catch(error => this.heart.submitSay('bench', `测试未启动：${error instanceof Error ? error.message : String(error)}`));
    return true;
  }

  private judgeBenchCard(card: TestCard, events: readonly BusEvent[]): boolean {
    const judge = card.judge;
    if (judge.type === 'event_seen') return events.some(event => event.type === judge.event);
    if (judge.type === 'position_reached') {
      const pos = this.cfg.game.getPosition();
      const target = judge.position;
      return Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z) <= judge.range;
    }
    return this.cfg.game.getInventoryItems().some(item => item.name === judge.item && item.count >= judge.count);
  }

  /** 供 TestBench/Hub 启停单次观测 Run；不改写正常任务执行链路。 */
  startBenchRun(runId: string, cardId: string): RunSummary {
    const summary = this.benchRecorder.start(runId, cardId);
    this.bus.publish('bench.run_started', 'info', { runId, cardId });
    return summary;
  }

  stopBenchRun(verdict: RunVerdict): RunSummary | null {
    const result = this.benchRecorder.stop(verdict);
    if (result) this.bus.publish('bench.run_finished', verdict.status === 'pass' ? 'info' : 'recoverable', { runId: result.runId, verdict });
    return result;
  }

  listBenchRuns(): RunSummary[] { return this.benchRecorder.list(); }
  readBenchRun(runId: string): RunTraceEvent[] { return this.benchRecorder.trace(runId); }

  // ── FEAT-MEM-05 · 位置轨迹采集 ───────────────────────────────────────
  private startTrajectoryRecording(): void {
    if (this.trajectoryTimer) return;
    const log = (msg: string) => this.cfg.onLog?.('info', `[v2][trajectory] ${msg}`);
    const recordOnce = () => {
      try {
        const pos = this.cfg.game.getPosition();
        if (!pos) return;
        const dim = this.cfg.game.getDimension?.() ?? 'overworld';
        const ts = Date.now();
        this.memory.record('trajectory', {
          timestamp: ts,
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          z: Math.round(pos.z),
          dimension: dim,
          biome: 'unknown',  // mineflayer block.biome 需 chunk 数据，暂占位
        });
      } catch (err) {
        log(`record failed: ${(err as Error).message}`);
      }
    };
    // 启动即记一行（避免 30s 空窗）
    recordOnce();
    this.trajectoryTimer = setInterval(recordOnce, V2Runtime.TRAJECTORY_INTERVAL_MS);
    log(`started (interval=${V2Runtime.TRAJECTORY_INTERVAL_MS}ms)`);
  }

  private stopTrajectoryRecording(): void {
    if (this.trajectoryTimer) {
      clearInterval(this.trajectoryTimer);
      this.trajectoryTimer = null;
      this.cfg.onLog?.('info', '[v2][trajectory] stopped');
    }
  }

  /** 调试 · 查看当前状态 */
  snapshot() {
    return {
      tick: this.perception.getWorldState()?.tick ?? 0,
      world: this.perception.getWorldState(),
      tasks: this.tasks.list(),
      memory: this.memory.snapshot(),
      learnedStrategies: this.strategySnapshot(), // FEAT-CROSS-07 R10 · 固化技能（避开 runtime.ts getV2Snapshot 的 L5 strategies 撞名）
      automaticDefenseEnabled: tuning().defense.automaticEnabled,
    };
  }

  /** FEAT-CROSS-07 R10 · 固化技能视图（页面渲染 fast 节点 + 置信度） */
  strategySnapshot(): Array<{ id: string; name: string; state: string; confidence: number; trialRuns: number; cleanSuccess: number; ownerVerdict: string | null }> {
    if (!this.strategyStore) return [];
    return this.strategyStore.list().map(s => ({
      id: s.id, name: s.name, state: s.lifecycle.state,
      confidence: Math.round(s.lifecycle.confidence * 100) / 100,
      trialRuns: s.lifecycle.trialRuns, cleanSuccess: s.lifecycle.cleanSuccess,
      ownerVerdict: s.lifecycle.ownerVerdict,
    }));
  }
}

function goalAgentRoundToolNames(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.tools)) return [];
  return payload.tools.flatMap(value => value && typeof value === 'object'
    && typeof (value as Record<string, unknown>).name === 'string'
    ? [String((value as Record<string, unknown>).name)]
    : []);
}
