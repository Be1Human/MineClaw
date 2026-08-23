/**
 * L7 · ToolRegistry（FEAT-L7-13 · 取代 dispatcher.ts 的 switch/case）
 *
 * 框架只做三件事：注册、查找、统一包装（事件 + typed reason + 世界快照）。
 * LLM 可见 schema 由 toLLMSchemas()/subset() 自动生成，与实现永不脱节。
 */

import type { LLMToolSchema } from '../../cognitive/llm/types.js';
import type {
  BriefWorldSnapshot,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolFailureReason,
  ToolResult,
} from './types.js';

/** skill 模式下永远暴露的元工具名（FEAT-L7-08） */
const META_TOOL_NAMES = ['invoke_skill', 'say', 'ask_master', 'stay_silent', 'recall_memory'] as const;

/**
 * FEAT-CROSS-08 v2 · 身体感知过滤配置。
 * 全量注册工具，出 schema / dispatch 时按当前身体态过滤：日常陪聊态（!embodied）
 * 只放行 companionSafe 名单，切换只翻 isEmbodied() 返回值，registry 不重建。
 */
export interface ToolRegistryOptions {
  /** 运行时现读身体态；缺省视为已挂身体（embodied=true），保持旧行为 */
  isEmbodied?: () => boolean;
  /** 日常陪聊态放行的工具名（say/ask_master/save_memory/join_game 等） */
  companionSafe?: ReadonlySet<string>;
  /** MainBrain 等无权读取游戏事实的 registry 必须关闭失败快照。 */
  failureWorldSnapshot?: boolean;
}

export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();
  /** 调用名别名 → 正名。 */
  private readonly callAliases = new Map<string, string>();

  constructor(
    private readonly ctx: ToolContext,
    private readonly bodyOpts: ToolRegistryOptions = {},
  ) {}

  /** 当前是否挂载游戏身体（缺省=true，兼容不传 opts 的场景） */
  private embodiedNow(): boolean {
    return this.bodyOpts.isEmbodied ? this.bodyOpts.isEmbodied() : true;
  }

  /** 某工具在当前身体态是否可见/可用：有身体全放行；无身体仅 companionSafe。 */
  private visibleNow(name: string): boolean {
    return this.embodiedNow() || (this.bodyOpts.companionSafe?.has(name) ?? false);
  }

  register(def: ToolDefinition): void {
    if (this.defs.has(def.name) || this.callAliases.has(def.name)) {
      throw new Error(`duplicate tool: ${def.name}`);
    }
    this.defs.set(def.name, def);
    for (const alias of def.callAliases ?? []) {
      if (this.defs.has(alias) || this.callAliases.has(alias)) {
        throw new Error(`duplicate tool alias: ${alias}`);
      }
      this.callAliases.set(alias, def.name);
    }
  }

  get(name: string): ToolDefinition | undefined {
    const def = this.defs.get(name) ?? this.defs.get(this.callAliases.get(name) ?? '');
    return def && this.visibleNow(def.name) ? def : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  size(): number {
    return this.defs.size;
  }

  /** 统一执行入口 · 与原 dispatcher.call 语义一致（事件 + typed reason + snapshot） */
  call(use: ToolCall): ToolResult {
    try {
      const def = this.get(use.tool);
      if (!def) throw new Error(`unknown tool: ${use.tool}`);
      if (!this.visibleNow(def.name)) throw new Error(`tool_unavailable_without_body:${def.name}`);
      const result = def.execute(use.input, this.ctx);
      this.ctx.bus.publish('l7.tool_use', 'info', { name: use.tool, input: use.input });
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.ctx.bus.publish('l7.tool_error', 'recoverable', { name: use.tool, error: msg });
      // FEAT-L7-02：失败时附带 typed reason + 世界快照 · 给 LLM 看到现状
      const reason = this._classifyReason(msg);
      const worldSnapshot = this.bodyOpts.failureWorldSnapshot === false ? undefined : this._buildBriefSnapshot();
      return { ok: false, result: { error: msg }, reason, worldSnapshot };
    }
  }

  /** 全量 LLM schema（兼容模式 · 无 skill）· hidden 工具不出 */
  toLLMSchemas(): LLMToolSchema[] {
    const out: LLMToolSchema[] = [];
    for (const def of this.defs.values()) {
      if (def.hidden || !this.visibleNow(def.name)) continue;
      out.push(this._toSchema(def));
    }
    return out;
  }

  /**
   * skill 模式下当前轮可用 schema：元工具永含 + uses 子集。
   * uses 里 registry 没有的名字静默跳过（skill 声明脱节由 llmLoop 激活时告警）。
   */
  subset(names: Iterable<string>): LLMToolSchema[] {
    const picked = new Set<string>(META_TOOL_NAMES);
    for (const n of names) {
      const def = this.get(n);
      if (def && !def.hidden && this.visibleNow(def.name)) picked.add(def.name);
    }
    const out: LLMToolSchema[] = [];
    for (const name of picked) {
      const def = this.defs.get(name);
      if (def && this.visibleNow(def.name)) out.push(this._toSchema(def));
    }
    return out;
  }

  /** 严格名单，不自动附加 skill 元工具；用于受限系统反馈回合。 */
  only(names: Iterable<string>): LLMToolSchema[] {
    const picked = new Set<string>();
    for (const name of names) {
      const def = this.get(name);
      if (def && !def.hidden && this.visibleNow(def.name)) picked.add(def.name);
    }
    return [...picked]
      .map(name => this.defs.get(name))
      .filter((def): def is ToolDefinition => !!def)
      .map(def => this._toSchema(def));
  }

  /** uses 名单里 registry 不认识的名字（skill 注册期校验/告警用） */
  unknownNames(names: Iterable<string>): string[] {
    const out: string[] = [];
    for (const n of names) if (!this.has(n)) out.push(n);
    return out;
  }

  private _toSchema(def: ToolDefinition): LLMToolSchema {
    return {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    };
  }

  /** FEAT-L7-02：把异常字符串归类为 typed reason，方便 LLM 区分"任务找不到""资源不足""非法入参" */
  private _classifyReason(msg: string): ToolFailureReason {
    const m = msg.toLowerCase();
    if (m.includes('no_world_state')) return 'no_world_state';
    if (m.includes('not found') || m.includes('start_failed') || m.includes('no_resolution')) return 'task_not_found';
    if (m.includes('require') || m.includes('invalid') || m.includes('missing')) return 'invalid_input';
    if (m.includes('precondition')) return 'precondition_unmet';
    if (m.includes('unavailable') || m.includes('no_resource')) return 'resource_unavailable';
    return 'internal_error';
  }

  /** FEAT-L7-02：构造 BriefWorldSnapshot（失败回注用） */
  private _buildBriefSnapshot(): BriefWorldSnapshot | undefined {
    const w = this.ctx.perception.getWorldState();
    if (!w) return undefined;
    const invTop5 = [...w.inventory.items]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(it => ({ name: it.name, count: it.count }));
    const threats = w.entities.filter(e => e.category === 'hostile').length;
    return {
      pos: {
        x: Math.round(w.self.position.x),
        y: Math.round(w.self.position.y),
        z: Math.round(w.self.position.z),
      },
      hp: Math.round(w.self.health),
      food: w.self.food,
      invTop5,
      threats,
    };
  }
}
