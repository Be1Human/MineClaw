/**
 * FEAT-L7-08 · Skill 协议类型定义
 *
 * 对齐 agentskills.io 开放标准：
 *   一个 skill = 一个文件夹，含必需的 SKILL.md。
 *   SKILL.md 头部是 YAML frontmatter（name + description 必填），
 *   余下是给 LLM 看的执行指令。
 */

/** SKILL.md 头部的 frontmatter（YAML） */
export interface AgentSkillFrontmatter {
  /** 唯一名 · 中文短语 · LLM 调 invoke_skill 时用这个名字 */
  name: string;
  /** 一行说明 · 注入 system 段做"发现"阶段，LLM 据此判定何时激活 */
  description: string;
  /** 分类标签（可选，给人看，目前不影响行为） */
  category?: string;
  /** 触发关键词（可选 · 主要给文档读者参考，不强制约束 LLM） */
  triggers?: string[];
  /** 本 skill 允许调用的底层工具 · 激活后 LLMToolLoop 按此过滤 tools 数组 */
  uses?: string[];
  /**
   * FEAT-CROSS-06 · 多 Agent 协作 · skill 归属（粒度分流）：
   *   'main' = 仅 MainAgent（派目标/管控）· 'goal' = 仅 GoalAgent（执行 how-to）
   *   'both' = 两者共享（感知/信息/对话，不削弱）· 缺省视为 'both'。
   */
  agent?: 'main' | 'goal' | 'both';
}

/** 加载后内存里一个完整的 skill */
export interface AgentSkill {
  meta: AgentSkillFrontmatter;
  /** SKILL.md 主体（去除 frontmatter）· 激活时塞进 messages 给 LLM 看 */
  body: string;
  /** 物理目录路径 · 用于加载 scripts/references/assets */
  dir: string;
  /** 来源：local 文件 / mcp server */
  source: 'local' | 'mcp';
}

/** 给 LLM 看的索引项 · 渐进式披露第一阶段 */
export interface AgentSkillIndexEntry {
  name: string;
  description: string;
}
