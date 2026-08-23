/**
 * L7 · ToolRegistry 类型契约（FEAT-L7-13）
 *
 * 一个工具 = 一个自包含定义 {schema + execute + terminal}，注册进 ToolRegistry。
 * ToolCall / ToolResult / typed reason / BriefWorldSnapshot 自原 dispatcher.ts 原样迁入，语义不变。
 */

import type { GameAdapter } from '../../../adapter/GameAdapter.js';
import type { PerceptionPipeline } from '../../perception/pipeline.js';
import type { TaskRuntime } from '../../task/taskRuntime.js';
import type { ResourceResolver, ResolutionResult } from '../../task/resourceResolver.js';
import type { DecisionPolicy } from '../../task/decisionPolicy.js';
import type { EventBusV2 } from '../../infra/eventBus.js';
import type { MemoryV2 } from '../../infra/memory.js';
import type { BotMemoryStore } from '../../infra/botMemory.js';
import type { AgentSkillRegistry } from '../../skills/skillRegistry.js';
import type { LLMToolSchema } from '../../cognitive/llm/types.js';
import type { GoalAgentPort } from '../../decision/goalAgentPort/goalAgentPort.js';

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * FEAT-L7-02：typed 失败原因（向后兼容 · 旧 caller 忽略此字段）。
 */
export type ToolFailureReason =
  | 'no_world_state'
  | 'task_not_found'
  | 'precondition_unmet'
  | 'resource_unavailable'
  | 'invalid_input'
  | 'internal_error';

/**
 * FEAT-L7-02：精简世界快照，跟随失败 ToolResult 回给 LLM，避免下一轮再 get_world_state。
 */
export interface BriefWorldSnapshot {
  pos: { x: number; y: number; z: number };
  hp: number;
  food: number;
  invTop5: Array<{ name: string; count: number }>;
  threats: number;
}

export interface ToolResult {
  ok: boolean;
  result: unknown;
  /** FEAT-L7-02：typed 失败原因 · 仅失败时填 */
  reason?: ToolFailureReason;
  /** FEAT-L7-02：失败时附带的世界快照 · 让 LLM 看到失败时的现状 */
  worldSnapshot?: BriefWorldSnapshot;
}

/** create_task 槽位声明子集（运行时注入完整 TaskRegistry，本就带 slots） */
export interface TaskSlotLike {
  name: string;
  type: string;
  defaultFrom?: string[];
  /** FEAT-L7-13 · 入参别名键（LLM 常把 material 写成 target/name 等）· 声明式归一 */
  aliases?: string[];
  askable?: boolean;
}

export interface TaskDefLike {
  priority: { default: number };
  preconditions: string[];
  slots?: { required: TaskSlotLike[]; optional?: TaskSlotLike[] };
  /** FEAT-L7-13 · 同类任务复用时允许合并的参数键白名单 */
  mergeKeys?: string[];
}

/** 工具执行所需的运行时依赖（原 DispatcherDeps · 字段语义不变） */
export interface ToolDeps {
  bus: EventBusV2;
  perception: PerceptionPipeline;
  tasks: TaskRuntime;
  game: GameAdapter;
  resolver: ResourceResolver;
  policy: DecisionPolicy;
  ownerName: string;
  /** BUG-CROSS-51 · MainBrain 获取/操作游戏的唯一端口。 */
  goalAgentPort?: Pick<GoalAgentPort, 'request'> & Partial<Pick<GoalAgentPort,
    'beginPlayerTurn' | 'beginContinuation' | 'endPlayerTurn' | 'markReplied' | 'isManagedRequest' | 'cancelSessions' | 'abandonSession' | 'getCurrentStatus'>>;
  taskRegistry?: {
    get(kind: string): TaskDefLike | undefined;
  };
  /** FEAT-MEM-02/03：位置记忆与自我定位用 · 缺省则相关工具返回不可用 */
  memory?: MemoryV2;
  /** FEAT-L7-09 · Hermes 内置记忆（MEMORY.md/USER.md）· save_memory 工具用 */
  botMemory?: BotMemoryStore;
  /** FEAT-CROSS-13 · 统一记忆门面；主脑自动注入与 recall_memory 共用。 */
  memorySystem?: {
    prepareContext(query: string, budget?: number): { text: string };
    deepRecall(input: {
      query: string;
      budget?: number;
      entities?: string[];
      locations?: string[];
      timeRange?: { from?: number; to?: number };
      includeEvidence?: boolean;
    }): unknown;
  };
  /** FEAT-L7-11 · self-improving · save_skill 工具写盘+热注册用 */
  skillRegistry?: AgentSkillRegistry;
  /** FEAT-CROSS-07 · 固化策略库 · manage_strategy 工具用（主人主权：列/禁用/删/认可） */
  strategyStore?: {
    list(): Array<{ id: string; name: string; description: string; lifecycle: { state: string; confidence: number } }>;
    ownerVerdict(id: string, v: 'approved' | 'rejected' | null): void;
    remove(id: string): void;
  };
  /** FEAT-CROSS-08 · 是否已挂载游戏身体。false 时隐藏游戏工具、speak 只走 UI。 */
  embodied?: boolean;
  /** FEAT-CROSS-08 v2 · 运行时现读身体态（热插拔）· 未传则回退 embodied 构造期快照。 */
  isEmbodied?: () => boolean;
  /** FEAT-CROSS-08 · 日常态 join_game 工具回调。 */
  onJoinGame?: () => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

/** 兼容别名 · 既有测试/调用方逐步迁移 */
export type DispatcherDeps = ToolDeps;

/**
 * 工具执行上下文 = 依赖 + 共享能力。
 * speak / recentOwnerText 原是 dispatcher 私有方法，上提为所有工具可用；
 * lastResolution 是 resolve_resource → decide_with_policy 的跨工具状态。
 */
export interface ToolContext extends ToolDeps {
  /** 只提交给 MainBrain 发言网关；上下文自身不得直接写游戏或 UI。 */
  speak(text: string, mode?: 'say' | 'ask_master'): void;
  /** 最近一条主人对话原文（required 槽 dialogue 提取用）· 无 memory 时返回空串 */
  recentOwnerText(): string;
  /** 上次 resolve_resource 的结果 · decide_with_policy 隐式取它 */
  lastResolution: ResolutionResult | null;
}

/**
 * 一个自包含的工具定义。新增工具 = 在 defs/ 下加一个定义并注册，不改框架。
 */
export interface ToolDefinition {
  name: string;
  /** LLM 可见的一行说明 */
  description: string;
  /** LLM function calling 的参数 JSON Schema */
  parameters: LLMToolSchema['function']['parameters'];
  /** 调用名别名，不出现在 LLM schema 里。 */
  callAliases?: string[];
  /** 调用后 turn 走向：end_turn（say/complete_task）· ask_master · 缺省=继续 */
  terminal?: 'end_turn' | 'ask_master';
  /** true = 可被调用但不暴露给 LLM（propose_chat 内部通路） */
  hidden?: boolean;
  /** true = 仅元工具（invoke_skill）：registry 只出 schema，执行由 loop 拦截 */
  metaOnly?: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): unknown;
}

/** 两点欧氏距离（多工具共用） */
export function dist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
