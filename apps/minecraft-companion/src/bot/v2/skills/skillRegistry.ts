/**
 * FEAT-L7-08 · AgentSkillRegistry
 *
 * 启动期扫描 skills/ 目录 + 可选 MCP servers，构造 skill 索引。
 * 给 LLMToolLoop 用：
 *   toPromptIndex()  → 给 LLM 看的"发现"阶段索引（只 name + description）
 *   activate(name)   → "激活"阶段，读全文塞进下一轮 messages
 *
 * 渐进式披露：启动期只有索引（每行约 50-80 字），命中一个 skill 才把它的全文（200-600 字）追加进 prompt。
 *
 * 命名说明：用 Agent 前缀，避免与 L4 的 SkillRegistry（动作技能：FollowSkill / FarmSkill 等）冲突。
 * 跟 agentskills.io 开放标准的术语保持一致。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadLocalSkills, serializeSkill } from './skillLoader.js';
import type { AgentSkill, AgentSkillIndexEntry, AgentSkillFrontmatter } from './types.js';

export class AgentSkillRegistry {
  private skills = new Map<string, AgentSkill>();
  private log: (msg: string) => void;
  /** FEAT-L7-11 · 本地 skills 根目录（loadLocalDir 时记下，createSkill 写盘用） */
  private rootDir: string | null = null;

  constructor(log?: (msg: string) => void) {
    this.log = log ?? ((m) => console.log(`[AgentSkillRegistry] ${m}`));
  }

  /** 启动期加载所有本地 SKILL.md。MCP server 后续注入通过 register() 走。 */
  loadLocalDir(rootDir: string): void {
    this.rootDir = rootDir;
    const skills = loadLocalSkills(rootDir, this.log);
    for (const s of skills) {
      if (this.skills.has(s.meta.name)) {
        this.log(`[skill] 重名跳过 · ${s.meta.name} @ ${s.dir}`);
        continue;
      }
      this.skills.set(s.meta.name, s);
    }
    this.log(`[skill] loaded ${skills.length} local skills from ${rootDir}`);
  }

  /**
   * FEAT-CROSS-06 · 多 Agent 协作 · 按 agent 归属过滤出子 registry。
   *   target='main' → 收 agent∈{main,both,缺省}；target='goal' → 收 agent∈{goal,both,缺省}。
   *   感知/信息/对话(both 或未标)两者共享，不削弱。
   */
  subsetForAgent(target: 'main' | 'goal'): AgentSkillRegistry {
    const sub = new AgentSkillRegistry(this.log);
    for (const s of this.skills.values()) {
      const a = s.meta.agent ?? 'both';
      if (a === 'both' || a === target) sub.register(s);
    }
    return sub;
  }

  /** 由 MCPClient 注入：把外部 server 暴露的工具包装成 skill 注册进来 */
  register(skill: AgentSkill): void {
    if (this.skills.has(skill.meta.name)) {
      this.log(`[skill] 重名拒绝 · ${skill.meta.name}（已有 source=${this.skills.get(skill.meta.name)!.source}）`);
      return;
    }
    this.skills.set(skill.meta.name, skill);
  }

  /** 给 LLM 看的索引行（每个 skill 一行）· 注入 system prompt 的"发现"段 */
  toPromptIndex(): string {
    const entries = this.indexEntries();
    if (entries.length === 0) return '（暂无可用 skill）';
    return entries
      .map(e => `- ${e.name}: ${e.description}`)
      .join('\n');
  }

  /** 拿索引数组（debug / WebUI / 单测用） */
  indexEntries(): AgentSkillIndexEntry[] {
    return Array.from(this.skills.values()).map(s => ({
      name: s.meta.name,
      description: s.meta.description,
    }));
  }

  /** 激活：返回完整 skill 对象（含 body + uses）· LLM 调 invoke_skill 时调它 */
  activate(name: string): AgentSkill | null {
    return this.skills.get(name) ?? null;
  }

  /** 列举全部 skill（debug） */
  list(): AgentSkill[] {
    return Array.from(this.skills.values());
  }

  /** 数量 */
  size(): number {
    return this.skills.size;
  }

  /**
   * FEAT-L7-11 · 自进化：把工作流写成新 skill，落盘 skills/<name>/SKILL.md + 热注册。
   * 重启后由 loadLocalDir 自然加载。带护栏（合法化 / 长度 / 必填 / 同名）。
   */
  createSkill(
    fm: AgentSkillFrontmatter,
    body: string,
    opts?: { improve?: boolean },
  ): { ok: boolean; reason?: string; dir?: string } {
    if (!this.rootDir) return { ok: false, reason: 'no_root_dir' };
    const name = (fm.name ?? '').trim();
    if (!name) return { ok: false, reason: 'missing_name' };
    if (!(fm.description ?? '').trim()) return { ok: false, reason: 'missing_description' };
    const cleanBody = (body ?? '').trim();
    if (cleanBody.length === 0) return { ok: false, reason: 'empty_body' };
    if (cleanBody.length > 4000) return { ok: false, reason: 'body_too_long' };

    const exists = this.skills.has(name);
    if (exists && !opts?.improve) return { ok: false, reason: 'already_exists' };

    const folder = sanitizeSkillName(name);
    if (!folder) return { ok: false, reason: 'invalid_name' };
    const dir = path.join(this.rootDir, folder);

    const meta: AgentSkillFrontmatter = {
      name,
      description: fm.description,
      category: fm.category ?? 'learned',
      triggers: fm.triggers ?? [],
      uses: fm.uses ?? [],
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), serializeSkill(meta, cleanBody), 'utf-8');
    } catch (e) {
      return { ok: false, reason: `write_failed: ${(e as Error).message}` };
    }
    this.skills.set(name, { meta, body: cleanBody, dir, source: 'local' });
    this.log(`[skill] ${exists ? 'improved' : 'created'} · ${name} @ ${dir}`);
    return { ok: true, dir };
  }
}

/** skill 名 → 安全文件夹名（中英数字+连字符，截断 40） */
function sanitizeSkillName(name: string): string {
  return name.replace(/[^\w一-龥-]/g, '').slice(0, 40);
}
