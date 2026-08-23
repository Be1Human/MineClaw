/**
 * FEAT-L7-08 · SKILL.md 文件加载器
 *
 * 扫描 skills/<name>/SKILL.md，解析 YAML frontmatter，返回 Skill 对象。
 * 跟 agentskills.io 开放标准的最小约定保持一致：frontmatter 必含 name + description。
 *
 * 不依赖 yaml lib（避免新增依赖）— 只支持简单 KEY: VALUE 与 KEY: [a, b, c] 形态。
 * Hermes / Claude Skills 写的 SKILL.md 也是这个最小子集，够用。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentSkill, AgentSkillFrontmatter } from './types.js';

/**
 * 把一段 frontmatter 文本（不含 `---` 分隔符）解析成 AgentSkillFrontmatter。
 * 支持：
 *   key: value                  → 字符串
 *   key: [a, b, c]              → 字符串数组
 *   key: "带空格的值"            → 字符串（去引号）
 * 不支持嵌套对象、多行字符串等复杂结构 — 走简单子集就够。
 */
export function parseFrontmatter(text: string): Partial<AgentSkillFrontmatter> {
  const result: Record<string, unknown> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (!key) continue;

    // 数组形态：[a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      result[key] = inner.length === 0
        ? []
        : inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s.length > 0);
      continue;
    }

    // 去掉成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result as Partial<AgentSkillFrontmatter>;
}

/** 把整个 SKILL.md 文件内容拆成 { frontmatter 对象, body 文本 } */
export function splitSkillFile(content: string): { fm: Partial<AgentSkillFrontmatter>; body: string } {
  // 去 BOM
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  // 必须以 `---` 开头才算有 frontmatter
  if (!content.startsWith('---')) {
    return { fm: {}, body: content };
  }
  // 找到第二个 `---`
  const end = content.indexOf('\n---', 3);
  if (end < 0) {
    return { fm: {}, body: content };
  }
  const fmText = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, '');
  return { fm: parseFrontmatter(fmText), body };
}

/**
 * FEAT-L7-11 · 把 frontmatter + body 序列化成 SKILL.md 文本。
 * 只用 parseFrontmatter 支持的最小子集（KEY: VALUE / KEY: [a,b]），保证写出去能再被解析回来。
 */
export function serializeSkill(fm: AgentSkillFrontmatter, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${fm.name}`);
  // 描述用双引号包裹（parseFrontmatter 会去成对引号）· 内部双引号换成单引号避免破坏
  lines.push(`description: "${(fm.description ?? '').replace(/"/g, "'")}"`);
  if (fm.category) lines.push(`category: ${fm.category}`);
  if (fm.triggers && fm.triggers.length > 0) lines.push(`triggers: [${fm.triggers.join(', ')}]`);
  if (fm.uses && fm.uses.length > 0) lines.push(`uses: [${fm.uses.join(', ')}]`);
  lines.push('---');
  lines.push('');
  lines.push(body.trim());
  lines.push('');
  return lines.join('\n');
}

/**
 * 扫描 skills/ 目录第一层子目录，加载每个含 SKILL.md 的 skill。
 * frontmatter 缺 name / description 的 skill 会被跳过 + warn。
 */
export function loadLocalSkills(
  rootDir: string,
  log?: (msg: string) => void,
): AgentSkill[] {
  if (!fs.existsSync(rootDir)) {
    log?.(`[skill] rootDir 不存在 · 跳过本地 skill 加载 · ${rootDir}`);
    return [];
  }
  const out: AgentSkill[] = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(rootDir, ent.name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const { fm, body } = splitSkillFile(content);
    if (!fm.name || !fm.description) {
      log?.(`[skill] 跳过 ${ent.name} · frontmatter 缺 name 或 description`);
      continue;
    }
    out.push({
      meta: {
        name: fm.name,
        description: fm.description,
        category: fm.category,
        triggers: fm.triggers ?? [],
        uses: fm.uses ?? [],
        agent: fm.agent, // FEAT-CROSS-06 A · 按 agent 分级（缺失=both）；漏拷会导致主脑拿到全部 goal skill
      },
      body: body.trim(),
      dir,
      source: 'local',
    });
  }
  return out;
}
