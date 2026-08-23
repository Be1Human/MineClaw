/**
 * 工具定义 · skill 域
 *   save_skill（FEAT-L7-11 self-improving）
 *   invoke_skill（FEAT-L7-08 元工具 · registry 只出 schema，执行由 llmLoop 拦截）
 */

import type { ToolDefinition } from '../types.js';

export const skillTools: ToolDefinition[] = [
  {
    name: 'save_skill',
    description: '把一段你刚跑通、以后还会复用的多步工作流，沉淀成一个新 skill 供以后 invoke。仅在工作流确实可复用时才用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 名 · 简短中文短语' },
        description: { type: 'string', description: '一行说明：何时该用这个 skill' },
        body: { type: 'string', description: 'SKILL.md 正文：何时用 / 步骤 / 调哪些底层工具' },
        uses: { type: 'array', items: { type: 'string' }, description: '该 skill 会用到的底层工具名数组' },
        improve: { type: 'boolean', description: '同名已存在时是否覆盖改进，默认 false' },
      },
      required: ['name', 'description', 'body'],
    },
    execute(input, ctx) {
      if (!ctx.skillRegistry) return { ok: false, error: 'skill_registry_unavailable' };
      const name = (input.name as string | undefined)?.trim();
      const description = (input.description as string | undefined)?.trim();
      const body = input.body as string | undefined;
      if (!name || !description || !body) return { ok: false, error: 'invalid_input' };
      const uses = Array.isArray(input.uses) ? (input.uses as string[]) : undefined;
      const improve = input.improve === true;
      const r = ctx.skillRegistry.createSkill(
        { name, description, category: 'learned', uses },
        body,
        { improve },
      );
      return { ok: r.ok, saved: r.ok, reason: r.reason, dir: r.dir };
    },
  },
  {
    name: 'invoke_skill',
    description: '激活你的一个内部 skill 来执行任务工作流。激活后会给你完整指令，并解锁它声明可用的底层工具；skill 的执行仍然是你在做。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 名（从可用 skill 索引中选）' },
      },
      required: ['name'],
    },
    metaOnly: true,
    execute() {
      // 元工具：llmLoop 在派发前拦截执行（激活 skill + 注入指令）。
      // 走到这里说明调用路径不对（如 ruleLoop 误调），按友好失败处理。
      return { ok: false, error: 'invoke_skill 由 LLM loop 拦截执行，不支持直接派发' };
    },
  },
];
