import { MineflayerConnection, ConnectionConfig, type SkinSyncStatus } from './mineflayer/index.js';
import { V2Runtime, type PlannerEvolutionMode, type V2RuntimeConfig } from './v2/index.js';
import { NullGameAdapter, NullNavAdapter, SwitchableGameAdapter, SwitchableNavAdapter } from './adapter/index.js';
import type { WorldStateView } from './v2/types.js';
import type { SpatialEntry } from './v2/infra/memory.js';
import type { Task } from './v2/task/taskRuntime.js';
import type { TerrainBlockEntry } from './v2/capability/worldScanCapability.js';
import { installDigTracer } from './v2/infra/digTracer.js';
import { SpeechThinkingCorrelator, type ChatMeta, type ChatRole } from './v2/decision/speechThinkingCorrelator.js';
import { join } from 'node:path';
import { CompanionCore, type CompanionCoreState, type InitiativePolicy } from './v2/companion/companionCore.js';
import type { ChatMessage, FactKind, FactStatus, MemoryFact } from './v2/infra/chatMemory.js';
import type { RunSummary, RunTraceEvent } from './v2/bench/runRecorder.js';
import type {
  LlmTraceCallDetail,
  LlmTraceEventSummaryPage,
  LlmTraceSessionPage,
  LlmTraceAgent,
} from './v2/infra/llmTrace/index.js';
import { resolveRuntimePersistencePaths } from './runtimePersistence.js';
import { PlannerEvolutionRuntime } from './v2/task/planner/evolution/plannerEvolutionRuntime.js';
import { formatPlannerExperienceBundle, type PlannerExperienceBundle } from './v2/task/planner/experience/plannerExperienceProvider.js';
import type { CharacterCardV1 } from '../character/types.js';
import { assembleCharacterPrompt } from '../character/characterPromptAssembler.js';
import type { VisualWorldBootstrap, VisualWorldDelta } from './adapter/VisualWorldSource.js';
import { tuning } from './v2/infra/tuning.js';

export function plannerEvolutionMode(value: string | undefined): PlannerEvolutionMode {
  return value === 'off' || value === 'active' || value === 'observe' ? value : 'off';
}

export function plannerExperimentsEnabled(
  value: string | undefined,
  profileId: string,
  profileAllowlist = process.env.PLANNER_EXPERIMENT_PROFILE_IDS,
): boolean {
  if(value!=='authorized')return false;
  const allowed=(profileAllowlist??'').split(',').map(item=>item.trim()).filter(Boolean);
  return allowed.length===0||allowed.includes(profileId);
}

// ─────────────── UI 视图类型 ───────────────
// 定义在 bot/ 层，hub/ 从这里引入，避免循环依赖

export interface NavUiState {
  hasGoal: boolean;
  goalPosition: { x: number; y: number; z: number } | null;
  /** v2 暂不提供实时路径点，预留字段给 3D 场景 */
  path: { x: number; y: number; z: number }[] | null;
  plannedRoute: { x: number; y: number; z: number }[] | null;
  status: 'idle' | 'moving' | 'following' | 'stuck';
}

export interface ThreatUiEntry {
  entityId: number | null;
  severity: 'low' | 'medium' | 'high';
  description: string;
  distance: number;
}

export interface BlockUiEntry {
  name: string;
  category: string;
  position: { x: number; y: number; z: number };
  /** 3D 场景做遮挡剔除用，v2 Memory 未记录，默认 false */
  exposedAny: boolean;
  exposedTop: boolean;
}

export interface WorldUiView {
  tick: number;
  timestamp: number;
  self: {
    position: { x: number; y: number; z: number };
    health: number;
    maxHealth: number;
    food: number;
    yaw: number;
    pitch: number;
    isOnGround: boolean;
  } | null;
  /** 环境 · PerceptionScene3D HUD 用（isDay/dimension/isRaining）· 缺这个会导致 3D 组件渲染崩溃 */
  environment: {
    dimension: string;
    timeOfDay: number;
    isDay: boolean;
    isRaining: boolean;
  };
  entities: {
    id: number;
    category: string;
    name: string;
    position: { x: number; y: number; z: number };
    distance: number;
  }[];
  threats: ThreatUiEntry[];
  blocks: BlockUiEntry[];
  navigation: NavUiState;
  /** FEAT-WEBUI-02 背包：之前漏在推送视图里 → 前端背包面板永远"暂无数据"。这里补齐。 */
  inventory: WorldStateView['inventory'] | null;
}

// ──────────────────────────────────────────

/** 危险方块名 */
const HAZARD_BLOCKS = new Set([
  'lava', 'fire', 'soul_fire', 'cactus', 'magma_block',
  'sweet_berry_bush', 'wither_rose', 'campfire', 'soul_campfire',
]);

/** 液体方块名 */
const LIQUID_BLOCKS = new Set(['water', 'lava']);

/**
 * 可交互/可穿过方块（无论 boundingBox 如何都应标 passable）。
 * 门关闭时 mineflayer 返回 boundingBox='block'，但实际上 bot 可以打开通过。
 */
function isPassableByName(name: string): boolean {
  if (name.endsWith('_door')) return true;           // oak_door, iron_door...
  if (name.endsWith('_trapdoor')) return true;       // oak_trapdoor...
  if (name.endsWith('_fence_gate')) return true;     // oak_fence_gate...
  if (name.endsWith('_sign') || name.endsWith('_wall_sign') || name.endsWith('_hanging_sign')) return true;
  if (name.endsWith('_carpet')) return true;
  if (name.endsWith('_pressure_plate')) return true;
  if (name.endsWith('_button')) return true;
  const passableNames = [
    'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
    'redstone_torch', 'redstone_wall_torch',
    'lantern', 'soul_lantern',
    'lever', 'tripwire', 'tripwire_hook',
    'snow', 'rail', 'powered_rail', 'detector_rail', 'activator_rail',
    'ladder', 'vine', 'cave_vines', 'cave_vines_plant',
    'short_grass', 'tall_grass', 'fern', 'large_fern',
    'dead_bush', 'seagrass', 'tall_seagrass',
    'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
    'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
    'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower',
    'lilac', 'rose_bush', 'peony', 'wither_rose',
    'sugar_cane', 'kelp', 'kelp_plant',
    'cobweb', 'string',
  ];
  if (passableNames.includes(name)) return true;
  // BUG-WEBUI-03 · §2.4 · 按模式匹配（门/门式栅栏/告示牌/按钮/压力板等可穿过结构）
  // 这些方块 boundingBox 不为 'empty' 但实际可通行 / 视觉上不该当实心墙渲染。
  return PASSABLE_NAME_PATTERNS.some(re => re.test(name));
}

/** BUG-WEBUI-03 · §2.4 · 按名称模式判断 passable，覆盖各色门/告示牌/按钮等。 */
const PASSABLE_NAME_PATTERNS: RegExp[] = [
  /_door$/,            // oak_door, iron_door, spruce_door, ...
  /_trapdoor$/,        // 各色活板门
  /_fence_gate$/,      // 栅栏门（但 _fence 本身不通过 → 用更严格的后缀）
  /_sign$/,            // oak_sign, birch_sign, ...
  /_wall_sign$/,
  /_hanging_sign$/,
  /_banner$/,
  /_wall_banner$/,
  /_button$/,          // stone_button, oak_button, ...
  /_pressure_plate$/,  // 各色压力板
];

/** 根据方块属性分配前端渲染 category */
function classifyTerrainBlock(b: TerrainBlockEntry): string {
  const name = b.name;
  if (LIQUID_BLOCKS.has(name)) return 'liquid';
  if (HAZARD_BLOCKS.has(name)) return 'hazard';
  if (b.boundingBox === 'empty' || isPassableByName(name)) return 'passable';
  return 'solid';
}

/**
 * 纯函数版 WorldUiView 组装 · 从 v2 感知快照 + spatial 记忆 + 运行任务 + 地形块 派生 UI 视图。
 * 独立导出供单元测试直接调用，BotRuntime.buildWorldUiView() 委托给本函数。
 */
export function assembleWorldUiView(
  ws: WorldStateView | null | undefined,
  spatialEntries: SpatialEntry[],
  runningTasks: Task[],
  /** BUG-WEBUI-02 · WorldScan 地形方块缓存（可选，不传则无地形数据） */
  terrainBlocks: TerrainBlockEntry[] = [],
): WorldUiView {
  const entities = ws?.entities ?? [];

  const threats: ThreatUiEntry[] = entities
    .filter(e => e.category === 'hostile')
    .map(e => ({
      entityId: e.id,
      severity: (e.distance < 5 ? 'high' : e.distance < 12 ? 'medium' : 'low') as 'low' | 'medium' | 'high',
      description: e.name,
      distance: e.distance,
    }));

  // 特殊方块（箱子/矿源等，来自 memory.spatial）
  const specialBlocks: BlockUiEntry[] = spatialEntries.map(s => ({
    name: (s.meta as { blockName?: string })?.blockName ?? s.kind,
    category: s.kind,
    position: s.position,
    exposedAny: false,
    exposedTop: false,
  }));

  // 地形方块（BUG-WEBUI-03 · 体积扫描，按 boundingBox/名称分配 category）
  const terrainBlockEntries: BlockUiEntry[] = terrainBlocks.map(b => ({
    name: b.name,
    category: classifyTerrainBlock(b),
    position: b.position,
    exposedAny: b.exposedAny ?? true,
    exposedTop: false,
  }));

  const blocks: BlockUiEntry[] = [...specialBlocks, ...terrainBlockEntries];

  const navTask = runningTasks.find(t =>
    ['move_to', 'follow_owner', 'follow_entity'].includes(t.kind),
  );
  const navigation: NavUiState = {
    hasGoal: !!navTask,
    goalPosition:
      (navTask?.params as { position?: { x: number; y: number; z: number } })?.position ?? null,
    path: null,
    plannedRoute: null,
    status: navTask
      ? (navTask.kind.startsWith('follow') ? 'following' : 'moving')
      : 'idle',
  };

  return {
    tick: ws?.tick ?? 0,
    timestamp: Date.now(),
    self: ws?.self ?? null,
    environment: {
      dimension: ws?.environment?.dimension ?? 'overworld',
      timeOfDay: ws?.environment?.timeOfDay ?? 0,
      isDay: ws?.environment?.isDay ?? true,
      isRaining: ws?.environment?.isRaining ?? false,
    },
    entities: entities.map(e => ({
      id: e.id,
      category: e.category,
      name: e.name,
      position: e.position,
      distance: e.distance,
      yaw: e.yaw,
    })),
    threats,
    blocks,
    navigation,
    inventory: ws?.inventory ?? null,
  };
}

export interface BotRuntimeConfig {
  /** Profile/Bot id · 用于 per-bot memory db。 */
  id?: string;
  /** Hub 作用域的数据目录；所有持久化产物必须从这里派生。 */
  dataDir?: string;
  connection: ConnectionConfig;
  /** 可选能力；未配置时仍启动 rule-only 纯聊天 Runtime。 */
  llm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  personality: {
    name: string;
    style: string;
    description: string;
    prompt: string;
  };
  /** 主人在 Minecraft 中的真实用户名，用于游戏聊天来源分类。 */
  ownerUsername?: string;
  characterCard?: CharacterCardV1;
  /** FEAT-MEM-09 · Profile 级纯聊天记忆配置。 */
  memory?: {
    semanticSearch?: boolean;
  };
  /** FEAT-CROSS-20 · 进化运行时装配模式；缺省为 off。 */
  plannerEvolutionMode?: PlannerEvolutionMode;
}

export type BotStatus = 'offline' | 'awake' | 'connecting' | 'online' | 'busy' | 'reconnecting' | 'error';
export type CompanionPhase = 'offline' | 'awake' | 'playing';

function formatPlannerExperienceForGoal(bundle: PlannerExperienceBundle | null, goalText: string): string {
  return formatPlannerExperienceBundle(bundle, goalText);
}

export interface BotFullStatus {
  status: BotStatus;
  companionPhase: CompanionPhase;
  embodied: boolean;
  connectionStatus: string;
  uptime: number;
  lastError?: string;
  lastActivity?: string;
  currentBehavior?: string;
  health?: number;
  food?: number;
  position?: { x: number; y: number; z: number };
  serverAddress: string;
  personality: string;
  isThinking?: boolean;
  skinSync?: SkinSyncStatus;
}

export class BotRuntime {
  private conn: MineflayerConnection;
  private v2: V2Runtime | null = null;
  private plannerEvolution: PlannerEvolutionRuntime | null = null;
  /** FEAT-CROSS-08 · V2 子模块始终持有这两个代理；进出游戏只换 target。 */
  private switchableGame: SwitchableGameAdapter | null = null;
  private switchableNav: SwitchableNavAdapter | null = null;
  /** FEAT-WEBUI-09 · 思考↔回答关联器（startV2 时初始化） */
  private speechCorrelator: SpeechThinkingCorrelator = new SpeechThinkingCorrelator(() => {});
  private uninstallDigTracer: (() => void) | null = null;
  /** v2 → 前端 UI 的推送定时器（1s 间隔） */
  private v2PushInterval: ReturnType<typeof setInterval> | null = null;
  private status: BotStatus = 'offline';
  private embodied = false;
  private switching = false;
  private config: BotRuntimeConfig;
  /** 跨进/退游戏保留；V2Runtime 重建时仍复用同一个陪伴状态。 */
  private companion: CompanionCore | null = null;
  private startedAt = Date.now();
  private lastError: string | null = null;
  private lastActivity: string | null = null;
  /** MineflayerConnection.events survives Bot replacement, so these handlers are installed once. */
  private connectionEventHandlersAttached = false;
  private visualWorldUnsubscribe: (() => void) | null = null;
  private visualWorldConsumers = 0;

  onStatusChange?: (status: BotStatus) => void;
  /** FEAT-WEBUI-09 · meta 携带 turnId + 该轮思考（供 UI 聊天面板分轨呈现） */
  onChat?: (sender: string, message: string, meta?: ChatMeta) => void;
  onLog?: (level: string, message: string) => void;
  onFullStatus?: (status: BotFullStatus) => void;
  onGameJoined?: () => void;
  onAgentLoop?: (step: { type: string; data: Record<string, unknown>; timestamp: number }) => void;
  /** v2 世界视图推送 · 替代 v1 的 onWorldState + onNavPhase */
  onV2WorldUiView?: (view: WorldUiView) => void;
  /** FEAT-WEBUI-27 · 与语义感知完全独立的视觉世界增量。 */
  onVisualWorldDelta?: (delta: VisualWorldDelta) => void;

  constructor(config: BotRuntimeConfig) {
    this.config = config;
    this.conn = new MineflayerConnection();
    this.conn.onSpawn = () => this.onGameJoined?.();
  }

  getStatus(): BotStatus { return this.status; }
  getConnectionStatus() { return this.conn.getStatus(); }

  async getVisualWorldBootstrap(): Promise<VisualWorldBootstrap | null> {
    const config = tuning().worldVisual;
    if (!config.enabled || !this.embodied) return null;
    return this.conn.visualWorldSource.createBootstrap({
      viewDistanceChunks: config.viewDistanceChunks,
      entityRenderDistance: config.entityRenderDistance,
    });
  }

  acquireVisualWorldStream(): boolean {
    if (!tuning().worldVisual.enabled || !this.embodied || !this.conn.visualWorldSource.isAvailable()) return false;
    this.visualWorldConsumers += 1;
    this.attachVisualWorldStream();
    return true;
  }

  releaseVisualWorldStream(): void {
    this.visualWorldConsumers = Math.max(0, this.visualWorldConsumers - 1);
    if (this.visualWorldConsumers === 0) this.detachVisualWorldStream();
  }

  /** FEAT-CROSS-09 · 用户控制面读取当前 Profile 的陪伴状态。 */
  getCompanionState(): CompanionCoreState | null {
    return this.companion?.exportState() ?? this.v2?.companion.exportState() ?? null;
  }

  setCompanionInitiativePolicy(patch: Partial<InitiativePolicy>): InitiativePolicy | null {
    const core = this.companion ?? this.v2?.companion;
    return core?.setInitiativePolicy(patch) ?? null;
  }

  rollbackCompanionOverlaysAfter(version: number): CompanionCoreState | null {
    const core = this.companion ?? this.v2?.companion;
    if (!core) return null;
    core.rollbackOverlaysAfter(version);
    return core.exportState();
  }

  correctCompanionEmotion(id: string, correction: string): CompanionCoreState | null {
    const core = this.companion ?? this.v2?.companion;
    if (!core) return null;
    core.correctEmotion(id, correction);
    return core.exportState();
  }

  /** FEAT-MEM-09 · 纯聊天记忆控制面：始终通过当前 Bot 的 Profile 作用域访问。 */
  getChatMemoryFacts(filter: { status?: FactStatus; query?: string } = {}): MemoryFact[] | null {
    return this.v2?.chatMemory.getFacts(filter) ?? null;
  }

  getRecentChatMessages(limit = 50): ChatMessage[] | null {
    return this.v2?.chatMemory.recentMessages(limit) ?? null;
  }

  addChatMemoryFact(input: {
    scope?: 'user' | 'agent'; kind: FactKind; text: string; confidence?: number; importance?: number; sourceMessageIds?: string[];
  }): MemoryFact | { rejected: string } | null {
    if (!this.v2) return null;
    const fact = {
      scope: input.scope ?? 'user', kind: input.kind, text: input.text,
      confidence: input.confidence ?? 1, importance: input.importance ?? 0.8,
    };
    return input.sourceMessageIds?.length
      ? this.v2.chatMemory.addFact({ ...fact, sourceMessageIds: input.sourceMessageIds })
      : this.v2.chatMemory.addManualFact(fact);
  }

  replaceChatMemoryFact(id: string, text: string, sourceMessageIds: string[] = []): MemoryFact | { rejected: string } | null {
    return this.v2?.chatMemory.replaceFact(id, text, sourceMessageIds) ?? null;
  }

  removeChatMemoryFact(id: string): boolean | null {
    return this.v2?.chatMemory.removeFact(id) ?? null;
  }

  restoreChatMemoryFact(id: string): MemoryFact | null {
    return this.v2?.chatMemory.restoreFact(id) ?? null;
  }

  getChatMemoryFactSources(id: string): ChatMessage[] | null {
    if (!this.v2) return null;
    const fact = this.v2.chatMemory.getFact(id);
    return fact ? this.v2.chatMemory.getMessagesByIds(fact.sourceMessageIds) : null;
  }

  rebuildChatMemoryIndex(): { indexed: number } | null {
    return this.v2?.chatMemory.rebuildSearchIndex() ?? null;
  }

  exportChatMemoryMarkdown(): string | null {
    return this.v2?.chatMemory.exportMarkdown() ?? null;
  }

  getBenchRuns(): RunSummary[] | null { return this.v2?.listBenchRuns() ?? null; }
  getBenchRun(runId: string): RunTraceEvent[] | null { return this.v2?.readBenchRun(runId) ?? null; }

  getLlmTraceSessions(input: {
    cursor?: string; limit?: number; taskId?: string; q?: string;
  } = {}): LlmTraceSessionPage | null {
    return this.v2?.llmTraceQuery.listSessions(input) ?? null;
  }

  getLlmTraceEvents(input: {
    sessionId?: string; afterSeq?: number; beforeSeq?: number; limit?: number;
    interactionSessionId?: string; taskId?: string; agent?: LlmTraceAgent; node?: string; status?: string; q?: string;
  } = {}): LlmTraceEventSummaryPage | null {
    return this.v2?.llmTraceQuery.listEvents(input) ?? null;
  }

  getLlmTraceCall(callId: string): LlmTraceCallDetail | null {
    return this.v2?.llmTraceQuery.getCall(callId) ?? null;
  }

  exportLlmTraceSession(sessionId: string): string | null {
    return this.v2?.llmTraceQuery.exportSession(sessionId) ?? null;
  }

  getFullStatus(): BotFullStatus {
    const ws = this.v2?.perception.getWorldState();
    const self = ws?.self;
    return {
      status: this.status,
      companionPhase: this.getCompanionPhase(),
      embodied: this.embodied,
      connectionStatus: this.conn.getStatus(),
      uptime: Date.now() - this.startedAt,
      lastError: this.lastError ?? undefined,
      lastActivity: this.lastActivity ?? undefined,
      currentBehavior: undefined,
      health: self?.health,
      food: self?.food,
      position: self
        ? { x: Math.round(self.position.x), y: Math.round(self.position.y), z: Math.round(self.position.z) }
        : undefined,
      serverAddress: `${this.config.connection.host}:${this.config.connection.port}`,
      personality: this.config.personality.name,
      isThinking: false,
    };
  }

  private getCompanionPhase(): CompanionPhase {
    if (!this.v2) return 'offline';
    return this.embodied ? 'playing' : 'awake';
  }

  async start(): Promise<void> {
    // FEAT-CROSS-08：start 只启动陪伴大脑，不再隐式连接 MC。
    if (this.v2 && !this.embodied) {
      this.log('info', 'start 跳过：陪伴大脑已在运行');
      return;
    }
    this.startedAt = Date.now();
    this.lastError = null;
    if (this.conn.isConnected()) {
      this.log('info', 'start 跳过：当前已在游戏中');
      return;
    }
    this.startCompanionBrain();
  }

  async tryConnect(): Promise<void> {
    this.setStatus('connecting');
    this.log('info', `正在连接 ${this.config.connection.host}:${this.config.connection.port}...`);

    try {
      // 注入日志函数，使 NavAdapter 诊断日志（setMovements）写入运行日志文件
      this.conn.setNavLogger((msg) => this.log('info', msg));
      await this.conn.connect(this.config.connection);
      this.attachEventHandlers();
      if (this.v2) {
        this.switchableGame?.setTarget(this.conn.gameAdapter);
        this.switchableNav?.setTarget(this.conn.navAdapter);
        this.embodied = true;
        this.v2.attachBody();
        this.startV2WorldUiPush();
      } else {
        this.embodied = true;
        this.startV2(true);
      }
      // 🔍 砸墙诊断打点（临时·已禁用）：digTracer 通过 monkey-patch bot.dig /
      // bot.pathfinder.setMovements / bot.pathfinder.goto 工作，疑似干扰基础寻路，
      // 临时下线观察。环境变量 DIG_TRACER=on 时才装。
      if (process.env.DIG_TRACER === 'on') {
        try {
          this.uninstallDigTracer?.();
          this.uninstallDigTracer = installDigTracer(
            this.conn.getBot(),
            (level, msg) => this.log(level, msg),
          );
        } catch (e) {
          this.log('warn', `[digTracer] 安装失败：${(e as Error).message}`);
        }
      }
      if (this.visualWorldConsumers > 0) this.attachVisualWorldStream();
      this.log('info', '🚀 v2.0 运行时已启动');
      this.setStatus('online');
      this.lastActivity = '成功上线';
      this.log('info', `已连接到 ${this.config.connection.host}:${this.config.connection.port}`);
    } catch (err) {
      const e = err as Error & { code?: string };
      const msg = e.code === 'ECONNREFUSED'
        ? `服务器 ${this.config.connection.host}:${this.config.connection.port} 无法连接`
        : (e.message || String(err));
      this.lastError = msg;
      this.setStatus(this.v2 ? 'awake' : 'offline');
      this.log('warn', `连接失败: ${msg}（Bot 保持离线状态，可随时重试）`);
    }
  }

  /**
   * FEAT-WEBUI-12 · 可选传入新连接配置（如切换服务器）：
   * 传入则合并进 this.config.connection 后再重连，使「改服务器→重连」即时生效；
   * 不传则保持原配置（向后兼容旧调用）。
   */
  async reconnect(connection?: Partial<ConnectionConfig>): Promise<void> {
    if (connection) {
      this.config.connection = { ...this.config.connection, ...connection };
    }
    await this.joinGame();
  }

  async joinGame(connection?: Partial<ConnectionConfig>): Promise<{ ok: boolean; error?: string }> {
    if (this.switching) return { ok: false, error: 'switching' };
    this.switching = true;
    try {
      if (connection) {
        this.config.connection = { ...this.config.connection, ...connection };
      }
      if (this.conn.isConnected() && this.embodied) {
        return { ok: true };
      }
      if (this.conn.isConnected()) {
        await this.conn.disconnect();
      }
      await this.tryConnect();
      if (this.embodied && this.conn.isConnected()) return { ok: true };
      this.startCompanionBrain();
      return { ok: false, error: this.lastError ?? 'connect_failed' };
    } finally {
      this.switching = false;
    }
  }

  async leaveGame(): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      // BUG-CROSS-25 · 先翻转身体态，让并发 Heartbeat 立即进入陪聊安全子循环。
      this.embodied = false;
      this.detachVisualWorldStream();
      this.stopV2WorldUiPush();
      this.v2?.detachBody();
      this.switchableGame?.setTarget(new NullGameAdapter(this.config.personality.name));
      this.switchableNav?.setTarget(new NullNavAdapter());
      if (this.conn.isConnected()) {
        await this.conn.disconnect();
      }
      this.startCompanionBrain();
      this.lastActivity = '已退出游戏，保持日常陪聊';
    } finally {
      this.switching = false;
    }
  }

  async stop(): Promise<void> {
    this.detachVisualWorldStream();
    this.stopV2();
    await this.conn.disconnect();
    this.setStatus('offline');
    this.lastActivity = '手动下线';
    this.log('info', '已断开连接');
  }

  // ─────────────── v2.0 runtime ───────────────

  private startCompanionBrain(): void {
    this.embodied = false;
    if (!this.v2) this.startV2(false);
    this.setStatus('awake');
    this.lastActivity = '日常陪聊中';
    this.log('info', '陪伴大脑已启动（日常陪聊态）');
  }

  private startV2(embodied: boolean): void {
    if (this.v2) return;
    const gameTarget = embodied ? this.conn.gameAdapter : new NullGameAdapter(this.config.personality.name);
    const navTarget = embodied ? this.conn.navAdapter : new NullNavAdapter();
    this.switchableGame ??= new SwitchableGameAdapter(gameTarget);
    this.switchableNav ??= new SwitchableNavAdapter(navTarget);
    this.switchableGame.setTarget(gameTarget);
    this.switchableNav.setTarget(navTarget);
    const memoryId = (this.config.id || this.config.personality.name || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dataDir = this.config.dataDir ?? 'data';
    const persistence = resolveRuntimePersistencePaths(dataDir, memoryId);
    const dbPath = persistence.memoryDbPath;
    const evolutionMode = this.config.plannerEvolutionMode ?? plannerEvolutionMode(process.env.PLANNER_EVOLUTION_MODE);
    const evolutionEnabled = evolutionMode !== 'off';
    if (evolutionEnabled) {
      this.plannerEvolution ??= new PlannerEvolutionRuntime({
        dbPath: persistence.plannerEvolutionDbPath,
        executionFactsPath: persistence.plannerExecutionFactsPath,
      });
      void this.plannerEvolution.start().catch(error => this.log('warn', `[PlannerEvolution] 启动失败，安全降级为无经验：${String(error)}`));
    }
    this.companion ??= new CompanionCore({
      profileId: this.config.id ?? memoryId,
      corePersona: {
        id: `core-${memoryId}`,
        version: 1,
        traits: this.config.characterCard?.character.personality.traits.length
          ? this.config.characterCard.character.personality.traits
          : [this.config.personality.description || this.config.personality.style],
        boundaries: [
          ...(this.config.characterCard?.character.personality.boundaries ?? []),
          '不把推断当作用户事实', '不以依赖或内疚操纵用户',
        ],
      },
    });
    // FEAT-WEBUI-09 · 每次起 v2 都新建关联器（重连后思考状态清零）
    this.speechCorrelator = new SpeechThinkingCorrelator((text, meta) => {
      if (text) this.onChat?.(this.config.personality.name, text, { ...meta, role: 'bot' });
    });
    const ownerName = this.config.characterCard?.relationship.userPersona.name || process.env.V2_OWNER || 'qxy';
    const ownerAliases = (process.env.V2_OWNER_ALIASES || 'cloudboyboy').split(',').map(s => s.trim()).filter(Boolean);
    const llmOk = !!(this.config.llm?.apiKey && this.config.llm?.baseUrl);
    const plannerEvolutionConfig: Partial<V2RuntimeConfig> = evolutionEnabled ? {
      plannerExperienceContext: goalText => formatPlannerExperienceForGoal(this.plannerEvolution?.experience.retrieve(goalText) ?? null, goalText),
      plannerExperienceSnapshot: goalText => this.plannerEvolution?.experience.retrieve(goalText) ?? null,
      plannerExperienceFreeze: request => this.plannerEvolution?.freezeForPlan({
        planRunId: request.planRunId,
        goalSignature: request.goalSignature,
        context: request.context,
        experimentsEnabled: plannerExperimentsEnabled(
          process.env.PLANNER_EXPERIMENT_MODE,
          this.config.id ?? memoryId,
        ),
      }) ?? {
        status: 'cold_start' as const,
        reason: 'no_applicable_experience' as const,
        selectionManifest: {
          id: `manifest:${request.planRunId}:runtime-unavailable`, planRunId: request.planRunId,
          query: { goalSignature: request.goalSignature.key, contextSignatureHash: 'runtime_unavailable' },
          selected: [], rejected: [],
        },
      },
      plannerExecutionFactsPath: persistence.plannerExecutionFactsPath,
      plannerPolicyInvalidationSubscribe: listener => this.plannerEvolution?.onPolicyInvalidated(listener) ?? (() => {}),
      plannerPlanTerminalNotify: terminal => this.plannerEvolution?.experiments.finalizePlanRun(
        terminal.planRunId,
        terminal.outcome,
        terminal.detail,
      ),
    } : {};
    this.v2 = new V2Runtime({
      game: this.switchableGame,
      nav: this.switchableNav,
      embodied,
      isEmbodied: () => this.embodied,
      ownerName,
      ownerAliases,
      tickMs: 200,
      blockingExecute: false,
      llm: llmOk ? this.config.llm : undefined,
      dbPath,
      worldMapDbPath: persistence.worldMapDbPath,
      runsDir: persistence.runsDir,
      strategyDir: persistence.strategyDir,
      chatProfileId: this.config.id ?? memoryId,
      chatMemoryDbPath: persistence.chatMemoryDbPath,
      chatMemorySemanticSearch: this.config.memory?.semanticSearch ?? true,
      chatMemoryAutoCapture: this.config.characterCard?.performance.capabilities.memory ?? true,
      botName: this.config.personality.name,
      persona: this.config.personality.style || this.config.personality.description,
      characterCard: this.config.characterCard,
      characterPrompt: this.config.characterCard
        ? (message: string) => assembleCharacterPrompt(this.config.characterCard!, message)
        : undefined,
      ...plannerEvolutionConfig,
      plannerRuntimeDbPath: persistence.plannerRuntimeDbPath,
      plannerExecutionCodeRevision: process.env.GIT_COMMIT || 'local-dev',
      plannerExecutionConfigRevision: memoryId,
      plannerEvolutionMode: evolutionMode,
      companion: this.companion,
      // BUG-L1-03: 注入真实 bot 让 patchedBlockAt 打到 bot.blockAt（接通 pathfinder 记忆寻路）
      getRawBotForPatch: () => {
        if (!embodied) return null;
        try { return this.conn.getBot() as unknown as import('./v2/infra/patchedBlockAt.js').BotBlockAtTarget; }
        catch { return null; }
      },
      onJoinGame: () => this.joinGame(),
      onLog: (level, msg) => this.log(level, msg),
      // bot 说话（L7 say/ask_master/propose_chat + say atomic）→ 回显到 Web UI 聊天面板
      onEvent: (ev) => {
        // FEAT-WEBUI-09 · 思考↔回答按 turnId 关联：turn/thought/say 事件喂给 correlator，
        // 命中 atomic.say 时由 correlator 回调 onChat（带 turnId + 本轮思考）。
        this.speechCorrelator.observe(ev.type, ev.payload as Record<string, unknown>);
        // Agent Loop / 执行活动事件转发到 WebUI（闭环可视化：让采集/合成/脱困/任务流也能看见）
        if (this.onAgentLoop && shouldForwardToUi(ev.type)) {
          this.onAgentLoop({
            type: ev.type,
            data: ev.payload as Record<string, unknown>,
            timestamp: ev.timestamp,
          });
        }
      },
    });
    this.v2.start();
    this.log(
      'info',
      `[v2] owner=${ownerName} · tick=200ms · mode=${llmOk ? 'LLM' : 'rule-only'} · body=${embodied ? 'game' : 'none'} · db=${dbPath}`,
    );

    if (embodied) this.startV2WorldUiPush();
  }

  /** BUG-WEBUI-06 · 身体挂载后启动，重复进服时保持单一推送流。 */
  private startV2WorldUiPush(): void {
    if (this.v2PushInterval) return;
    this.v2PushInterval = setInterval(() => {
      if (this.v2 && this.embodied && this.onV2WorldUiView) {
        try {
          this.onV2WorldUiView(this.buildWorldUiView());
        } catch {
          // 推送失败不影响 bot 运行
        }
      }
    }, 1000);
  }

  private stopV2WorldUiPush(): void {
    if (!this.v2PushInterval) return;
    clearInterval(this.v2PushInterval);
    this.v2PushInterval = null;
  }

  private attachVisualWorldStream(): void {
    if (this.visualWorldUnsubscribe || this.visualWorldConsumers === 0 || !tuning().worldVisual.enabled) return;
    this.visualWorldUnsubscribe = this.conn.visualWorldSource.subscribe(delta => {
      if (this.embodied) this.onVisualWorldDelta?.(delta);
    });
  }

  private detachVisualWorldStream(): void {
    this.visualWorldUnsubscribe?.();
    this.visualWorldUnsubscribe = null;
  }

  private stopV2(): void {
    this.stopV2WorldUiPush();
    // 卸载 digTracer（重连前清理，下次连接再装新的）
    try { this.uninstallDigTracer?.(); } catch { /* ignore */ }
    this.uninstallDigTracer = null;
    this.plannerEvolution?.stop();
    this.plannerEvolution = null;
    if (!this.v2) return;
    this.v2.stop();
    this.v2 = null;
    this.embodied = false;
  }

  /**
   * 从 v2 perception + memory 组装 WorldUiView
   * PerceptionScene3D.vue 消费的字段全部向后兼容：
   *   blocks[].name/category/position/exposedAny/exposedTop
   *   threats[].entityId/severity/description/distance
   *   navigation.hasGoal/goalPosition/path/plannedRoute/status
   *   entities[].id/category/name/position/distance
   */
  private buildWorldUiView(): WorldUiView {
    return assembleWorldUiView(
      this.v2?.perception.getWorldState(),
      this.v2?.memory.query('spatial') ?? [],
      this.v2?.tasks.list().filter(t => t.state === 'running') ?? [],
      this.v2?.worldScan.getNearbyTerrainBlocks() ?? [],
    );
  }

  sendChat(message: string): void {
    if (!this.v2) this.startCompanionBrain();
    this.v2?.notifyBrain({
      source: 'runtime.sendChat',
      topic: 'external_speech_request',
      label: '外部接口请求发言',
      detail: message,
      wake: true,
    });
  }

  async applyServerSkin(textureUrl: string, model: 'classic' | 'slim'): Promise<void> {
    await this.conn.applyServerSkin(textureUrl, model);
  }

  async chat(sender: string, message: string): Promise<string> {
    if (!this.v2) {
      this.startCompanionBrain();
    }
    this.lastActivity = `和 ${sender} 聊天`;
    this.onChat?.(sender, message, { role: 'owner' });
    this.log('info', `[chat:web] ${sender}: "${message}"`);
    // 把网页消息送进 v2 MainBrain（直聊 · 跳过 AddressDetector）
    this.v2?.injectOwnerChat(message);
    return `(${this.config.personality.name} 正在思考...)`;
  }

  private attachEventHandlers(): void {
    if (this.connectionEventHandlersAttached) return;
    this.connectionEventHandlersAttached = true;
    this.conn.events.on('chat', (event) => {
      const { sender, message } = event.data as { sender: string; message: string };
      if (sender === this.config.personality.name) return;
      this.onChat?.(sender, message, { role: this.resolveGameChatRole(sender) });
      this.log('info', `[chat:game] ${sender}: "${message}"`);
    });

    this.conn.events.on('connection_change', (event) => {
      const { status } = event.data as { status: string };
      if (status === 'connected' && this.status !== 'online') {
        this.setStatus('online');
        this.lastActivity = '重新上线';
      } else if (status === 'reconnecting') {
        this.setStatus('reconnecting');
        this.lastActivity = '尝试重连...';
      } else if (status === 'failed') {
        this.setStatus('offline');
        this.lastError = '连接中断，重连失败';
        this.lastActivity = '连接丢失';
      }
    });
  }

  private resolveGameChatRole(sender: string): ChatRole {
    const normalized = sender.trim().toLocaleLowerCase();
    const configuredOwners = [
      this.config.ownerUsername,
      this.config.characterCard?.relationship.userPersona.name,
      process.env.V2_OWNER,
      ...(process.env.V2_OWNER_ALIASES || '').split(','),
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim().toLocaleLowerCase());
    return configuredOwners.includes(normalized) ? 'owner' : 'external';
  }

  private setStatus(status: BotStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
    this.onFullStatus?.(this.getFullStatus());
  }

  private log(level: string, message: string): void {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${ts}] [${level}] ${message}`);
    this.onLog?.(level, message);
  }

  /** v2 tasks list · returns null if v2 not running */
  getV2Tasks(): Record<string, unknown>[] | null {
    if (!this.v2) return null;
    return this.v2.tasks.list().map(t => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      priority: t.priority,
      params: t.params,
      parentId: t.parentId ?? null,
      progress: t.progress ?? null,
      label: t.label ?? null,        // 人话意图（taskLabel/镜像节点）· 缺了树里只会显示"正在忙…"
      failure: t.failure ?? null,    // 失败原因（失败子步骤可展示）
    }));
  }

  cancelActiveTasks(reason = 'cancelled_by_owner'): number | null {
    return this.v2?.cancelActiveTasks(reason) ?? null;
  }

  /** v2 critic verdicts (last 10) · returns null if v2 not running */
  getV2CriticVerdicts(): Record<string, unknown>[] | null {
    if (!this.v2) return null;
    const events = this.v2.memory.query('event', { type: 'critic.verdict' });
    const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    return sorted.map(ev => {
      const p = ev.payload as Record<string, unknown>;
      const status = (p.status as string) ?? null;
      return {
        taskId: p.taskId ?? null,
        taskKind: p.taskKind ?? null,
        score: p.score ?? null,
        // passed: true=success / null=partial(正常进行中) / false=fail
        passed: status === 'success' ? true : status === 'fail' ? false : null,
        status,
        detail: p.reason ?? p.detail ?? null,
        timestamp: ev.timestamp,
      };
    });
  }

  /** v2 supervisor alerts · returns null if v2 not running */
  getV2SupervisorAlerts(): Record<string, unknown> | null {
    if (!this.v2) return null;
    const insp = this.v2.supervisor.inspect();
    return {
      suspendedByDanger: insp.suspendedByDanger,
      recentDiagnoses: insp.recentDiagnoses,
      narrationCooldowns: insp.narrationCooldowns,
    };
  }

  /** v2 snapshot · returns null if v2 not running */
  getV2Snapshot(): Record<string, unknown> | null {
    if (!this.v2) return null;
    const snap = this.v2.snapshot();
    return {
      ...snap,
      strategies: [
        { id: 'survival_strategy', ...this.v2.survival.inspect() },
        { id: 'follow_strategy', ...this.v2.follow.inspect() },
        { id: 'farm_strategy', ...this.v2.farm.inspect() },
        { id: 'gather_strategy', ...this.v2.gather.inspect() },
        { id: 'provision_strategy', ...this.v2.provision.inspect() },
        { id: 'reflex_strategy', ...this.v2.reflex.inspect() },
      ],
      supervisor: this.v2.supervisor.inspect(),
      pendingDecision: null,
    };
  }
}

/**
 * 决定哪些 bus 事件转发到 WebUI 活动流。
 * 闭环可视化：放行 L7 决策 + 任务生命周期 + 采集/合成/开门/脱困/评测等"有意义的动作"，
 * 屏蔽每 tick 高频噪音（heartbeat.* / atomic.move_to / arbitrate 等）。
 */
function shouldForwardToUi(type: string): boolean {
  if (type.startsWith('l7.')) return true;
  if (type === 'goalagent.report' || type === 'goalagent.progress_report.governed' || type === 'goalagent.continuation') return true;
  if (type.startsWith('gather.')) return true;
  if (type.startsWith('provision.')) return true;
  if (type.startsWith('door.')) return true;
  if (type.startsWith('stuck.')) return true;
  if (type === 'navigation.stuck_unrecovered') return true;
  if (type === 'atomic.craft.start' || type === 'atomic.craft.success' || type === 'atomic.craft.fail') return true;
  if (
    type === 'task.created' || type === 'task.started' || type === 'task.completed' ||
    type === 'task.failed' || type === 'task.paused' || type === 'task.resumed' ||
    type === 'task.subtask_done'
  ) return true;
  if (type === 'critic.verdict') return true;
  return false;
}
