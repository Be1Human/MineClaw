/**
 * FEAT-L7-08 · SkillRegistry + skillLoader 单测
 *
 * 覆盖：
 *   C-01 · loadLocalDir 加载真实 skills/ 目录里的 SKILL.md
 *   C-02 · parseFrontmatter 简单字符串字段
 *   C-03 · parseFrontmatter 数组字段
 *   C-04 · splitSkillFile 含 BOM
 *   C-05 · splitSkillFile 无 frontmatter
 *   C-06 · toPromptIndex 输出格式
 *   C-07 · activate('不存在') 返回 null
 *   C-08 · activate 返回完整 body
 *   C-09 · 重名 skill 拒绝
 *   C-10 · frontmatter 缺 name 的 skill 跳过
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AgentSkillRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillRegistry.js';
import { parseFrontmatter, splitSkillFile, loadLocalSkills } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────── helper · 临时目录创建 ───────────

function makeTmpSkillsDir(skills: Record<string, string>): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minefriend-skills-test-'));
  for (const [name, content] of Object.entries(skills)) {
    const skillDir = path.join(tmpRoot, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  }
  return tmpRoot;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─────────── tests ───────────

describe('AgentSkillRegistry + skillLoader', () => {

  // C-02
  it('C-02 · parseFrontmatter 简单字符串字段', () => {
    const fm = parseFrontmatter('name: 测试\ndescription: 一行说明\ncategory: task');
    assert.equal(fm.name, '测试');
    assert.equal(fm.description, '一行说明');
    assert.equal(fm.category, 'task');
  });

  // C-03
  it('C-03 · parseFrontmatter 数组字段', () => {
    const fm = parseFrontmatter('triggers: [砍, 挖, 采]\nuses: ["say", "ask_master"]');
    assert.deepEqual(fm.triggers, ['砍', '挖', '采']);
    assert.deepEqual(fm.uses, ['say', 'ask_master']);
  });

  // C-04
  it('C-04 · splitSkillFile 含 BOM', () => {
    const content = '﻿---\nname: foo\ndescription: bar\n---\n# 正文';
    const { fm, body } = splitSkillFile(content);
    assert.equal(fm.name, 'foo');
    assert.equal(body, '# 正文');
  });

  // C-05
  it('C-05 · splitSkillFile 无 frontmatter', () => {
    const { fm, body } = splitSkillFile('# 纯正文，无 frontmatter');
    assert.equal(fm.name, undefined);
    assert.equal(body, '# 纯正文，无 frontmatter');
  });

  // C-01
  it('C-01 · loadLocalSkills 加载临时目录两个 skill', () => {
    const tmp = makeTmpSkillsDir({
      '采集': '---\nname: 采集\ndescription: 砍/挖\nuses: [say]\n---\n# body A',
      '合成': '---\nname: 合成\ndescription: 做物品\n---\n# body B',
    });
    try {
      const skills = loadLocalSkills(tmp);
      assert.equal(skills.length, 2);
      const names = skills.map(s => s.meta.name).sort();
      assert.deepEqual(names, ['合成', '采集']);
      const gather = skills.find(s => s.meta.name === '采集')!;
      assert.equal(gather.body, '# body A');
      assert.deepEqual(gather.meta.uses, ['say']);
    } finally {
      cleanup(tmp);
    }
  });

  // C-10
  it('C-10 · frontmatter 缺 name 的 skill 跳过', () => {
    const tmp = makeTmpSkillsDir({
      'good': '---\nname: good\ndescription: ok\n---\nbody',
      'broken': '---\ndescription: 缺 name\n---\nbody',
    });
    try {
      const skills = loadLocalSkills(tmp);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]!.meta.name, 'good');
    } finally {
      cleanup(tmp);
    }
  });

  // C-06
  it('C-06 · toPromptIndex 输出格式', () => {
    const tmp = makeTmpSkillsDir({
      '采集': '---\nname: 采集\ndescription: 砍/挖\n---\nbody',
      '合成': '---\nname: 合成\ndescription: 做物品\n---\nbody',
    });
    try {
      const reg = new AgentSkillRegistry(() => {});
      reg.loadLocalDir(tmp);
      const idx = reg.toPromptIndex();
      assert.ok(idx.includes('- 采集: 砍/挖'));
      assert.ok(idx.includes('- 合成: 做物品'));
      assert.equal(reg.size(), 2);
    } finally {
      cleanup(tmp);
    }
  });

  // C-07
  it('C-07 · activate 不存在的 skill 返回 null', () => {
    const reg = new AgentSkillRegistry(() => {});
    assert.equal(reg.activate('不存在'), null);
  });

  // C-08
  it('C-08 · activate 返回完整 body + uses', () => {
    const tmp = makeTmpSkillsDir({
      '采集': '---\nname: 采集\ndescription: 砍/挖\nuses: [decompose_task, start_task, say]\n---\n# 完整 body 文本',
    });
    try {
      const reg = new AgentSkillRegistry(() => {});
      reg.loadLocalDir(tmp);
      const sk = reg.activate('采集');
      assert.ok(sk !== null);
      assert.equal(sk!.body, '# 完整 body 文本');
      assert.deepEqual(sk!.meta.uses, ['decompose_task', 'start_task', 'say']);
    } finally {
      cleanup(tmp);
    }
  });

  // C-09
  it('C-09 · 同名 skill 重复加载只保留第一个', () => {
    const reg = new AgentSkillRegistry(() => {});
    reg.register({
      meta: { name: '采集', description: 'first', uses: [] },
      body: 'A', dir: '/tmp/a', source: 'local',
    });
    reg.register({
      meta: { name: '采集', description: 'second', uses: [] },
      body: 'B', dir: '/tmp/b', source: 'mcp',
    });
    const sk = reg.activate('采集');
    assert.equal(sk?.body, 'A', '应保留首次注册');
  });

  // 真实仓库 skills/ 目录抽测
  it('R-01 · 加载真实仓库 skills/ 目录的 SKILL.md（如果存在）', () => {
    const real = path.resolve(__dirname, '../../../../../../skills');
    if (!fs.existsSync(real)) {
      return; // 跳过：仓库 skills/ 还没建
    }
    const reg = new AgentSkillRegistry(() => {});
    reg.loadLocalDir(real);
    // 至少有 1 个 skill（实施 Step 1 后会有"采集材料"）
    assert.ok(reg.size() >= 1, `仓库 skills/ 至少应有 1 个 skill，实测 ${reg.size()}`);
  });

  it('CROSS-001 · 能力索引把后续执行归为伙伴自己的内部循环', () => {
    const real = path.resolve(__dirname, '../../../../../../skills');
    if (!fs.existsSync(real)) return;
    const reg = new AgentSkillRegistry(() => {});
    reg.loadLocalDir(real);
    const skill = reg.activate('能力索引');
    assert.ok(skill, '真实技能目录应包含能力索引');
    assert.match(skill!.meta.description, /你的内部执行循环/);
    assert.match(skill!.body, /整件事始终都是你在做、你在负责/);
    assert.doesNotMatch(`${skill!.meta.description}\n${skill!.body}`, /MainAgent|GoalAgent|任务系统会自己/);
  });

});
