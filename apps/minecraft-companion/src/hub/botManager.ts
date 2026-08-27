import { BotRuntime, BotRuntimeConfig, BotStatus, BotFullStatus } from '../bot/runtime.js';
import type { WorldUiView } from '../bot/runtime.js';
import type { ChatMeta } from '../bot/v2/decision/speechThinkingCorrelator.js';
import type { BotProfile } from './profileStore.js';
import type { CompanionCoreState, InitiativePolicy } from '../bot/v2/companion/companionCore.js';
import type { ChatMessage, FactKind, FactStatus, MemoryFact } from '../bot/v2/infra/chatMemory.js';
import type { RunSummary, RunTraceEvent } from '../bot/v2/bench/runRecorder.js';
import type {
  LlmTraceAgent,
  LlmTraceCallDetail,
  LlmTraceEventSummaryPage,
  LlmTraceSessionPage,
} from '../bot/v2/infra/llmTrace/index.js';
import { resolveProfileLlmConfig } from './llmConfig.js';
import type { LlmAgentConfigStore } from './llmAgentConfigStore.js';
import { resolveCharacterCard } from '../character/migrateCharacterCard.js';
import type { SkinSyncStatus } from '../bot/mineflayer/types.js';
import { SkinSyncService } from './skinSyncService.js';
import type { ServerPreset, ServerPresetStore } from './serverPresetStore.js';

export interface BotInstance {
  id: string;
  profileId: string;
  status: BotStatus;
  fullStatus: BotFullStatus | null;
  skinSync: SkinSyncStatus;
  startedAt: number;
}

export class BotManager {
  private instances = new Map<string, {
    runtime: BotRuntime;
    instance: BotInstance;
    profile: BotProfile;
    skinSyncRun: number;
  }>();
  private readonly skinSyncService: SkinSyncService;
  defaultLlm: { apiKey: string; baseUrl: string; model: string } | null = null;

  constructor(
    private readonly dataDir = 'data',
    private readonly llmAgentConfigStore?: LlmAgentConfigStore,
    private readonly serverPresetStore?: ServerPresetStore,
    skinSyncService?: SkinSyncService,
  ) {
    this.skinSyncService = skinSyncService ?? new SkinSyncService(dataDir);
  }

  onStatusChange?: (botId: string, status: BotStatus) => void;
  onFullStatus?: (botId: string, status: BotFullStatus) => void;
  onChat?: (botId: string, sender: string, message: string, meta?: ChatMeta) => void;
  onLog?: (botId: string, level: string, message: string) => void;
  onV2WorldUiView?: (botId: string, view: WorldUiView) => void;
  onAgentLoop?: (botId: string, step: { type: string; data: Record<string, unknown>; timestamp: number }) => void;

  async start(profile: BotProfile): Promise<BotInstance> {
    const existing = this.instances.get(profile.id);
    if (existing) {
      existing.instance.fullStatus = existing.runtime.getFullStatus();
      existing.instance.status = existing.runtime.getStatus();
      return existing.instance;
    }

    const characterCard = resolveCharacterCard(profile);
    const connection = this.resolveConnection(profile);
    const config: BotRuntimeConfig = {
      id: profile.id,
      dataDir: this.dataDir,
      connection: {
        host: connection.host,
        port: connection.port,
        username: profile.name,
        version: connection.version,
        auth: connection.auth,
        reconnect: { enabled: true, maxRetries: 5, baseDelay: 5000, maxDelay: 60000 },
      },
      llm: this.resolveLlmConfig(profile),
      personality: {
        name: characterCard.character.identity.name || profile.name,
        style: profile.personality.style,
        description: profile.personality.description,
        prompt: profile.personality.prompt ?? profile.personality.description,
      },
      characterCard,
      memory: {
        semanticSearch: profile.memory?.semanticSearch ?? true,
      },
    };

    const runtime = new BotRuntime(config);
    const instance: BotInstance = {
      id: profile.id,
      profileId: profile.id,
      status: 'offline',
      fullStatus: null,
      skinSync: this.idleSkinSync(),
      startedAt: Date.now(),
    };

    const entry = { runtime, instance, profile, skinSyncRun: 0 };

    runtime.onStatusChange = (status) => {
      instance.status = status;
      this.onStatusChange?.(profile.id, status);
    };

    runtime.onFullStatus = (fullStatus) => {
      instance.fullStatus = this.withSkinSync(entry, fullStatus);
      this.onFullStatus?.(profile.id, instance.fullStatus);
    };

    runtime.onGameJoined = () => {
      void this.syncSkin(profile.id);
    };

    runtime.onChat = (sender, message, meta) => {
      this.onChat?.(profile.id, sender, message, meta);
    };

    runtime.onLog = (level, message) => {
      this.onLog?.(profile.id, level, message);
    };

    runtime.onV2WorldUiView = (view) => {
      this.onV2WorldUiView?.(profile.id, view);
    };

    runtime.onAgentLoop = (step) => {
      this.onAgentLoop?.(profile.id, step);
    };

    this.instances.set(profile.id, entry);

    // 非阻塞启动 — 即使连接失败 Bot 也保持存活
    await runtime.start();
    instance.fullStatus = runtime.getFullStatus();
    return instance;
  }

  async stop(botId: string): Promise<void> {
    const entry = this.instances.get(botId);
    if (!entry) return;
    await entry.runtime.stop();
    this.instances.delete(botId);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.instances.keys(), botId => this.stop(botId)));
  }

  /**
   * 用最新 Profile 原子重建单个 Runtime。
   *
   * 设置保存后不能继续复用构造时的旧 LLMClient；若此前已挂载游戏身体，
   * 重建纯聊天大脑后按最新连接配置恢复挂载。
   */
  async restart(profile: BotProfile): Promise<BotInstance> {
    const existing = this.instances.get(profile.id);
    const wasEmbodied = existing?.runtime.getFullStatus()?.embodied === true;
    if (existing) await this.stop(profile.id);

    const instance = await this.start(profile);
    if (wasEmbodied) await this.joinGame(profile.id, profile);
    return instance;
  }

  /** Restart only profiles that already have a live runtime. */
  async restartActiveProfiles(profiles: BotProfile[]): Promise<number> {
    const activeProfiles = profiles.filter(profile => this.instances.has(profile.id));
    await Promise.all(activeProfiles.map(profile => this.restart(profile)));
    return activeProfiles.length;
  }

  private resolveLlmConfig(profile: BotProfile) {
    if (profile.llmConfigId) {
      const config = this.llmAgentConfigStore?.get(profile.llmConfigId);
      if (!config) throw new Error(`LLM Agent configuration not found: ${profile.llmConfigId}`);
      return resolveProfileLlmConfig(config, this.defaultLlm);
    }
    if (profile.llm) return resolveProfileLlmConfig(profile.llm, this.defaultLlm);
    return undefined;
  }

  /**
   * FEAT-WEBUI-12 · 传入最新 profile 则按其 server 重建连接配置后重连，
   * 使「改服务器→重连」即时生效；不传则沿用启动时配置（向后兼容）。
   */
  async reconnect(botId: string, profile?: BotProfile): Promise<BotFullStatus | null> {
    const entry = this.instances.get(botId);
    if (!entry) return null;
    if (profile) entry.profile = profile;
    const connection = profile ? this.resolveConnection(profile) : undefined;
    await entry.runtime.reconnect(connection);
    return this.withSkinSync(entry, entry.runtime.getFullStatus());
  }

  async joinGame(botId: string, profile?: BotProfile): Promise<BotFullStatus | null> {
    const entry = this.instances.get(botId);
    if (!entry) return null;
    if (profile && !resolveCharacterCard(profile).performance.capabilities.minecraft) {
      throw new Error('该角色未启用 Minecraft 能力');
    }
    if (profile) entry.profile = profile;
    const connection = profile ? this.resolveConnection(profile) : undefined;
    await entry.runtime.joinGame(connection);
    entry.instance.fullStatus = this.withSkinSync(entry, entry.runtime.getFullStatus());
    entry.instance.status = entry.runtime.getStatus();
    return entry.instance.fullStatus;
  }

  async leaveGame(botId: string): Promise<BotFullStatus | null> {
    const entry = this.instances.get(botId);
    if (!entry) return null;
    await entry.runtime.leaveGame();
    entry.skinSyncRun++;
    entry.instance.skinSync = this.idleSkinSync();
    entry.instance.fullStatus = this.withSkinSync(entry, entry.runtime.getFullStatus());
    entry.instance.status = entry.runtime.getStatus();
    return entry.instance.fullStatus;
  }

  getStatus(botId: string): BotInstance | undefined {
    return this.instances.get(botId)?.instance;
  }

  getFullStatus(botId: string): BotFullStatus | null {
    const entry = this.instances.get(botId);
    return entry ? this.withSkinSync(entry, entry.runtime.getFullStatus()) : null;
  }

  getV2Snapshot(botId: string): Record<string, unknown> | null {
    return this.instances.get(botId)?.runtime.getV2Snapshot() ?? null;
  }

  getV2Tasks(botId: string): Record<string, unknown>[] | null {
    return this.instances.get(botId)?.runtime.getV2Tasks() ?? null;
  }

  cancelActiveTasks(botId: string, reason?: string): number | null {
    return this.instances.get(botId)?.runtime.cancelActiveTasks(reason) ?? null;
  }

  getV2CriticVerdicts(botId: string): Record<string, unknown>[] | null {
    return this.instances.get(botId)?.runtime.getV2CriticVerdicts() ?? null;
  }

  getV2SupervisorAlerts(botId: string): Record<string, unknown> | null {
    return this.instances.get(botId)?.runtime.getV2SupervisorAlerts() ?? null;
  }

  getCompanionState(botId: string): CompanionCoreState | null {
    return this.instances.get(botId)?.runtime.getCompanionState() ?? null;
  }

  setCompanionInitiativePolicy(botId: string, patch: Partial<InitiativePolicy>): InitiativePolicy | null {
    return this.instances.get(botId)?.runtime.setCompanionInitiativePolicy(patch) ?? null;
  }

  rollbackCompanionOverlaysAfter(botId: string, version: number): CompanionCoreState | null {
    return this.instances.get(botId)?.runtime.rollbackCompanionOverlaysAfter(version) ?? null;
  }

  correctCompanionEmotion(botId: string, id: string, correction: string): CompanionCoreState | null {
    try {
      return this.instances.get(botId)?.runtime.correctCompanionEmotion(id, correction) ?? null;
    } catch {
      return null;
    }
  }

  getChatMemoryFacts(botId: string, filter: { status?: FactStatus; query?: string } = {}): MemoryFact[] | null {
    return this.instances.get(botId)?.runtime.getChatMemoryFacts(filter) ?? null;
  }

  getRecentChatMessages(botId: string, limit = 50): ChatMessage[] | null {
    return this.instances.get(botId)?.runtime.getRecentChatMessages(limit) ?? null;
  }

  addChatMemoryFact(botId: string, input: {
    scope?: 'user' | 'agent'; kind: FactKind; text: string; confidence?: number; importance?: number; sourceMessageIds?: string[];
  }): MemoryFact | { rejected: string } | null {
    return this.instances.get(botId)?.runtime.addChatMemoryFact(input) ?? null;
  }

  replaceChatMemoryFact(botId: string, id: string, text: string, sourceMessageIds: string[] = []): MemoryFact | { rejected: string } | null {
    return this.instances.get(botId)?.runtime.replaceChatMemoryFact(id, text, sourceMessageIds) ?? null;
  }

  removeChatMemoryFact(botId: string, id: string): boolean | null {
    return this.instances.get(botId)?.runtime.removeChatMemoryFact(id) ?? null;
  }

  restoreChatMemoryFact(botId: string, id: string): MemoryFact | null {
    return this.instances.get(botId)?.runtime.restoreChatMemoryFact(id) ?? null;
  }

  getChatMemoryFactSources(botId: string, id: string): ChatMessage[] | null {
    return this.instances.get(botId)?.runtime.getChatMemoryFactSources(id) ?? null;
  }

  rebuildChatMemoryIndex(botId: string): { indexed: number } | null {
    return this.instances.get(botId)?.runtime.rebuildChatMemoryIndex() ?? null;
  }

  exportChatMemoryMarkdown(botId: string): string | null {
    return this.instances.get(botId)?.runtime.exportChatMemoryMarkdown() ?? null;
  }

  getBenchRuns(botId: string): RunSummary[] | null { return this.instances.get(botId)?.runtime.getBenchRuns() ?? null; }
  getBenchRun(botId: string, runId: string): RunTraceEvent[] | null { return this.instances.get(botId)?.runtime.getBenchRun(runId) ?? null; }

  getLlmTraceSessions(botId: string, input: {
    cursor?: string; limit?: number; taskId?: string; q?: string;
  } = {}): LlmTraceSessionPage | null {
    return this.instances.get(botId)?.runtime.getLlmTraceSessions(input) ?? null;
  }

  getLlmTraceEvents(botId: string, input: {
    sessionId?: string; afterSeq?: number; beforeSeq?: number; limit?: number;
    interactionSessionId?: string; taskId?: string; agent?: LlmTraceAgent; node?: string; status?: string; q?: string;
  } = {}): LlmTraceEventSummaryPage | null {
    return this.instances.get(botId)?.runtime.getLlmTraceEvents(input) ?? null;
  }

  getLlmTraceCall(botId: string, callId: string): LlmTraceCallDetail | null {
    return this.instances.get(botId)?.runtime.getLlmTraceCall(callId) ?? null;
  }

  exportLlmTraceSession(botId: string, sessionId: string): string | null {
    return this.instances.get(botId)?.runtime.exportLlmTraceSession(sessionId) ?? null;
  }

  listAll(): BotInstance[] {
    return Array.from(this.instances.values()).map(e => ({
      ...e.instance,
      fullStatus: this.withSkinSync(e, e.runtime.getFullStatus()),
    }));
  }

  private resolveConnection(profile: BotProfile): BotProfile['server'] {
    const preset = profile.server.presetId ? this.serverPresetStore?.get(profile.server.presetId) : undefined;
    return preset ? {
      presetId: preset.id,
      host: preset.host,
      port: preset.port,
      version: preset.version,
      auth: preset.auth ?? 'offline',
    } : profile.server;
  }

  private resolveSkinPreset(profile: BotProfile): ServerPreset | undefined {
    return profile.server.presetId ? this.serverPresetStore?.get(profile.server.presetId) : undefined;
  }

  private async syncSkin(botId: string): Promise<void> {
    const entry = this.instances.get(botId);
    if (!entry) return;
    const run = ++entry.skinSyncRun;
    this.setSkinSync(entry, {
      state: 'pending',
      adapterId: 'skinsrestorer',
      message: '正在同步游戏内皮肤',
      updatedAt: Date.now(),
    });

    const prepared = await this.skinSyncService.prepare(entry.profile, this.resolveSkinPreset(entry.profile));
    if (run !== entry.skinSyncRun || !this.instances.has(botId)) return;
    if (prepared.state !== 'ready') {
      this.setSkinSync(entry, { ...prepared, updatedAt: Date.now() });
      return;
    }

    try {
      await entry.runtime.applyServerSkin(prepared.textureUrl, prepared.model);
      if (run !== entry.skinSyncRun || !this.instances.has(botId)) return;
      this.setSkinSync(entry, {
        state: 'synced',
        adapterId: 'skinsrestorer',
        skinDigest: prepared.skinDigest,
        message: '游戏内皮肤已与 MineClaw 同步',
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (run !== entry.skinSyncRun || !this.instances.has(botId)) return;
      const reasonCode = error instanceof Error ? error.message : 'skin_sync_failed';
      this.setSkinSync(entry, {
        state: 'failed',
        adapterId: 'skinsrestorer',
        skinDigest: prepared.skinDigest,
        reasonCode,
        message: reasonCode === 'skin_sync_not_confirmed'
          ? '服务器未确认皮肤更新，请检查 SkinsRestorer 和权限'
          : '游戏内皮肤同步失败',
        updatedAt: Date.now(),
      });
    }
  }

  private setSkinSync(
    entry: { runtime: BotRuntime; instance: BotInstance },
    status: SkinSyncStatus,
  ): void {
    entry.instance.skinSync = status;
    entry.instance.fullStatus = { ...entry.runtime.getFullStatus(), skinSync: status };
    this.onFullStatus?.(entry.instance.id, entry.instance.fullStatus);
    this.onLog?.(entry.instance.id, status.state === 'failed' ? 'warn' : 'info', `[skin-sync] ${status.state}${status.reasonCode ? ` ${status.reasonCode}` : ''}: ${status.message ?? ''}`);
  }

  private withSkinSync(
    entry: { instance: BotInstance },
    fullStatus: BotFullStatus,
  ): BotFullStatus {
    return { ...fullStatus, skinSync: entry.instance.skinSync };
  }

  private idleSkinSync(): SkinSyncStatus {
    return { state: 'idle', message: '尚未进入游戏', updatedAt: Date.now() };
  }

  sendChat(botId: string, message: string): void {
    this.instances.get(botId)?.runtime.sendChat(message);
  }

  async chat(botId: string, sender: string, message: string): Promise<string | null> {
    const entry = this.instances.get(botId);
    if (!entry) return null;
    return entry.runtime.chat(sender, message);
  }
}
