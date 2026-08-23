/**
 * 🧠 FEAT-L7-09 · BotMemoryStore — Hermes 内置记忆 TS 化（基础记忆）
 *
 * 移植 Hermes 的 MEMORY.md / USER.md 内置记忆机制：
 *   - MEMORY.md  agent 自己的笔记（行为 / 约定 / 世界事实）
 *   - USER.md    关于主人的事实（偏好 / 习惯）
 *
 * "always-active"：开场 load() 注入 systemPrompt；agent 调 save_memory 自主 append。
 *
 * 设计原则（同 MemoryV2）：纯被动文件仓库，只暴露 load / append / read，不依赖其它模块。
 * 与 MemoryV2 互不干扰——记忆走独立 Markdown 文件，不碰 SQLite 7 张表。
 */

import * as fs from 'fs';
import * as path from 'path';

export type MemoryScope = 'memory' | 'user';
export type RecallMode = 'always' | 'index';

export interface BotMemoryConfig {
  /** 记忆目录 · 默认 'data/memories' */
  dir: string;
  /** 召回模式 · always=全量注入 / index=精简 · 默认 always */
  recallMode?: RecallMode;
  /** 每个 scope 注入上限（条）· 默认 50 · 防 prompt 撑爆 */
  maxInject?: number;
  /** 是否按主人分文件存 USER.md · 默认 false（单份共享）· 预留多主人 */
  perOwnerUser?: boolean;
}

const SCOPE_FILES: Record<MemoryScope, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
};

export class BotMemoryStore {
  private readonly dir: string;
  private readonly recallMode: RecallMode;
  private readonly maxInject: number;
  private readonly perOwnerUser: boolean;
  private readonly log: (m: string) => void;

  constructor(cfg: BotMemoryConfig, log?: (m: string) => void) {
    this.dir = cfg.dir;
    this.recallMode = cfg.recallMode ?? 'always';
    this.maxInject = cfg.maxInject ?? 50;
    this.perOwnerUser = cfg.perOwnerUser ?? false;
    this.log = log ?? ((m) => console.log(`[BotMemory] ${m}`));
  }

  /** 解析某 scope 的文件绝对路径 */
  private filePath(scope: MemoryScope, ownerName?: string): string {
    if (scope === 'user' && this.perOwnerUser && ownerName) {
      return path.join(this.dir, sanitize(ownerName), SCOPE_FILES.user);
    }
    return path.join(this.dir, SCOPE_FILES[scope]);
  }

  /** 读原始记忆行（去 '- ' 前缀与 '#' 标题、空行）· 文件不存在返回 [] */
  read(scope: MemoryScope, ownerName?: string): string[] {
    const fp = this.filePath(scope, ownerName);
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, 'utf-8');
    return raw
      .split('\n')
      .map((l) => l.replace(/^\s*-\s?/, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  }

  /** agent 写一条记忆 · 自动建文件 + 行级去重 · 返回是否真的写入 */
  append(text: string, scope: MemoryScope, ownerName?: string): boolean {
    const clean = text.trim();
    if (!clean) return false;
    if (this.read(scope, ownerName).some((l) => l === clean)) {
      this.log(`[${scope}] 重复跳过 · ${clean.slice(0, 30)}`);
      return false;
    }
    const fp = this.filePath(scope, ownerName);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // 首次创建带标题头（与 Hermes 一致：首次写入才创建文件）
    if (!fs.existsSync(fp)) {
      const title = scope === 'user' ? '# 关于主人的记忆（USER.md）' : '# Bot 笔记（MEMORY.md）';
      fs.writeFileSync(fp, `${title}\n`, 'utf-8');
    }
    fs.appendFileSync(fp, `- ${clean}\n`, 'utf-8');
    this.log(`[${scope}] +1 · ${clean.slice(0, 40)}`);
    return true;
  }

  /**
   * 开场注入块 · 把 USER.md + MEMORY.md 拼成 systemPrompt 文本。
   * 空则返回 ''（不造空段）。
   */
  load(ownerName?: string): string {
    const cap = this.recallMode === 'index' ? Math.min(this.maxInject, 20) : this.maxInject;
    const user = this.read('user', ownerName).slice(-cap);
    const notes = this.read('memory').slice(-cap);
    if (user.length === 0 && notes.length === 0) return '';

    const lines: string[] = [];
    if (user.length > 0) {
      lines.push('关于主人：');
      for (const u of user) lines.push(`- ${u}`);
    }
    if (notes.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('你记下的事：');
      for (const n of notes) lines.push(`- ${n}`);
    }
    return lines.join('\n');
  }
}

/** 主人名转安全文件夹名（多主人预留） */
function sanitize(name: string): string {
  return name.replace(/[^\w一-龥-]/g, '_');
}
