/**
 * L7 · TaskRegistry
 *
 * 加载 .task.yaml 文件，提供任务定义查询和渐进式 prompt 生成。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYamlStr } from 'yaml';
import type { TaskDefinition } from './types.js';

export class TaskRegistry {
  private defs = new Map<string, TaskDefinition>();

  /** 从目录加载所有 .task.yaml / .task.json 文件 */
  loadAll(dir: string): void {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.task.yaml') || f.endsWith('.task.json'));
    } catch {
      return; // 目录不存在则静默跳过
    }
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      let def: TaskDefinition;
      if (file.endsWith('.json')) {
        def = JSON.parse(content) as TaskDefinition;
      } else {
        def = this.parseTaskYaml(content);
      }
      this.register(def);
    }
  }

  register(def: TaskDefinition): void {
    this.defs.set(def.kind, def);
  }

  get(kind: string): TaskDefinition | undefined {
    return this.defs.get(kind);
  }

  /** 按自然语言模糊匹配 */
  search(text: string): TaskDefinition[] {
    const lower = text.toLowerCase();
    return this.listAll().filter(d =>
      d.aliases.some(a => lower.includes(a)) || lower.includes(d.kind),
    );
  }

  listAll(): TaskDefinition[] {
    return Array.from(this.defs.values());
  }

  /** L0：system prompt 用的任务能力列表 */
  toPromptSummary(): string {
    const lines = this.listAll().map(d => `- ${d.kind}: ${d.summary}`);
    return `可执行的任务：\n${lines.join('\n')}`;
  }

  /** L1：某任务的 slot 详情（LLM 选定任务后注入） */
  getSlotPrompt(kind: string): string {
    const d = this.defs.get(kind);
    if (!d) return '';
    const reqSlots = d.slots.required.map(s => `  - ${s.name} (${s.type}): ${s.description}`);
    const optSlots = d.slots.optional.map(s => `  - ${s.name} (${s.type}, 可选): ${s.description}`);
    const parts = [`任务 ${kind} 参数：`];
    if (reqSlots.length) parts.push(`必填：\n${reqSlots.join('\n')}`);
    if (optSlots.length) parts.push(`可选：\n${optSlots.join('\n')}`);
    if (d.preconditions.length) parts.push(`前置条件：${d.preconditions.join(', ')}`);
    if (d.examples.length) parts.push(`示例：${d.examples.slice(0, 3).join(' / ')}`);
    return parts.join('\n');
  }

  /** L2：某任务的 cookbook（执行中遇问题时注入） */
  getCookbookPrompt(kind: string): string {
    const d = this.defs.get(kind);
    if (!d?.cookbook) return '';
    const c = d.cookbook;
    const parts = [`${kind} 知识：`];
    if (c.steps.length) parts.push(`步骤：${c.steps.join(' → ')}`);
    if (c.failures.length) {
      const fs = c.failures.map(f => `  ${f.condition} → ${f.strategies.join(' / ')}`);
      parts.push(`失败恢复：\n${fs.join('\n')}`);
    }
    if (c.completion) parts.push(`完成条件：${c.completion}`);
    return parts.join('\n');
  }

  /** 解析 YAML 格式的 task 文件 */
  private parseTaskYaml(content: string): TaskDefinition {
    const parsed = parseYamlStr(content) as Record<string, unknown>;
    return this.normalizeDefinition(parsed);
  }

  private normalizeDefinition(raw: Record<string, unknown>): TaskDefinition {
    const priority = raw.priority as { default?: number; tier?: string } | undefined;
    const slots = raw.slots as { required?: unknown[]; optional?: unknown[] } | undefined;
    return {
      kind: raw.kind as string,
      aliases: (raw.aliases as string[]) ?? [],
      summary: (raw.summary as string) ?? '',
      priority: {
        default: priority?.default ?? 20,
        tier: priority?.tier ?? 'autonomous',
      },
      persistent: (raw.persistent as boolean) ?? false,
      slots: {
        required: (slots?.required ?? []) as TaskDefinition['slots']['required'],
        optional: (slots?.optional ?? []) as TaskDefinition['slots']['optional'],
      },
      preconditions: (raw.preconditions as string[]) ?? [],
      strategy: (raw.strategy as string) ?? '',
      cookbook: raw.cookbook as TaskDefinition['cookbook'],
      examples: (raw.examples as string[]) ?? [],
      // FEAT-L6-03 阶段二 · 后置断言（可缺省）
      postconditions: raw.postconditions as TaskDefinition['postconditions'],
      // FEAT-L7-13 · 复用合并白名单（可缺省）
      mergeKeys: raw.mergeKeys as string[] | undefined,
    };
  }
}
