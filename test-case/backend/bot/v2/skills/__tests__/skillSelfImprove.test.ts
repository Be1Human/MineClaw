/**
 * Skill 自进化单测 · FEAT-L7-11（self-improving）
 * Framework: node:test + node:assert/strict
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSkillRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillRegistry.js';
import { serializeSkill, splitSkillFile } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillLoader.js';

function freshReg() {
  const dir = mkdtempSync(join(tmpdir(), 'skillreg-'));
  const reg = new AgentSkillRegistry(() => {});
  reg.loadLocalDir(dir); // 空目录 → 0 skill，但记下 rootDir
  return { dir, reg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('Skill 自进化 · serializeSkill', () => {
  test('序列化后能被 splitSkillFile 往返解析', () => {
    const fm = { name: '夜间挖矿', description: '天黑陪主人下矿', category: 'learned', triggers: ['挖矿'], uses: ['say', 'start_task'] };
    const text = serializeSkill(fm, '## 步骤\n1. 跟随\n2. 挖');
    const { fm: parsed, body } = splitSkillFile(text);
    assert.equal(parsed.name, '夜间挖矿');
    assert.equal(parsed.description, '天黑陪主人下矿');
    assert.deepEqual(parsed.uses, ['say', 'start_task']);
    assert.match(body, /步骤/);
  });
});

describe('Skill 自进化 · createSkill', () => {
  test('正常创建 → 写盘 + 热注册 + 可激活', () => {
    const { dir, reg, cleanup } = freshReg();
    const before = reg.size();
    const r = reg.createSkill({ name: '护送挖矿', description: '陪主人下矿', uses: ['say'] }, '## 步骤\n跟随');
    assert.equal(r.ok, true);
    assert.equal(reg.size(), before + 1);
    assert.ok(reg.activate('护送挖矿'));
    assert.ok(existsSync(join(dir, '护送挖矿', 'SKILL.md')));
    assert.ok(reg.indexEntries().some((e) => e.name === '护送挖矿'));
    cleanup();
  });

  test('同名非 improve → 拒绝', () => {
    const { reg, cleanup } = freshReg();
    reg.createSkill({ name: 'A', description: 'd' }, 'body1');
    const r = reg.createSkill({ name: 'A', description: 'd' }, 'body2');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'already_exists');
    cleanup();
  });

  test('improve:true → 覆盖 body', () => {
    const { reg, cleanup } = freshReg();
    reg.createSkill({ name: 'B', description: 'd' }, 'old body');
    const r = reg.createSkill({ name: 'B', description: 'd' }, 'new body', { improve: true });
    assert.equal(r.ok, true);
    assert.equal(reg.activate('B')?.body, 'new body');
    cleanup();
  });

  test('缺 description → 拒', () => {
    const { reg, cleanup } = freshReg();
    const r = reg.createSkill({ name: 'C', description: '' }, 'body');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_description');
    cleanup();
  });

  test('空 body → 拒', () => {
    const { reg, cleanup } = freshReg();
    const r = reg.createSkill({ name: 'D', description: 'd' }, '   ');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_body');
    cleanup();
  });

  test('body 超 4000 字 → 拒', () => {
    const { reg, cleanup } = freshReg();
    const r = reg.createSkill({ name: 'E', description: 'd' }, 'x'.repeat(4001));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'body_too_long');
    cleanup();
  });

  test('未 loadLocalDir（无 rootDir）→ 拒', () => {
    const reg = new AgentSkillRegistry(() => {});
    const r = reg.createSkill({ name: 'F', description: 'd' }, 'body');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_root_dir');
  });

  test('learned 类默认标记', () => {
    const { reg, cleanup } = freshReg();
    reg.createSkill({ name: 'G', description: 'd' }, 'body');
    assert.equal(reg.activate('G')?.meta.category, 'learned');
    cleanup();
  });
});
