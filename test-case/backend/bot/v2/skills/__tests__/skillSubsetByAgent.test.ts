/**
 * AgentSkillRegistry.subsetForAgent · 单测（FEAT-CROSS-06 · skill 按 agent 分级）
 * 核心：感知/信息(both 或未标)两者共享不削弱；执行 how-to(goal)只给 GoalAgent；派目标(main)只给 MainAgent。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSkillRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillRegistry.js';
import type { AgentSkill } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/types.js';

function skill(name: string, agent?: 'main' | 'goal' | 'both'): AgentSkill {
  return { meta: { name, description: name, agent }, body: '', dir: '', source: 'local' };
}

function build(): AgentSkillRegistry {
  const r = new AgentSkillRegistry(() => {});
  r.register(skill('感知世界', 'both'));
  r.register(skill('采集材料', 'goal'));
  r.register(skill('能力索引', 'main'));
  r.register(skill('老skill无标签')); // 缺省 → both
  return r;
}

test('T1 · main 子集 = main + both + 未标（含感知，不削弱）', () => {
  const main = build().subsetForAgent('main');
  const names = main.indexEntries().map(e => e.name).sort();
  assert.deepEqual(names, ['感知世界', '老skill无标签', '能力索引'].sort());
  assert.ok(!names.includes('采集材料'), 'main 不含 goal 执行 skill');
});

test('T2 · goal 子集 = goal + both + 未标（含感知，会干活）', () => {
  const goal = build().subsetForAgent('goal');
  const names = goal.indexEntries().map(e => e.name).sort();
  assert.deepEqual(names, ['感知世界', '采集材料', '老skill无标签'].sort());
  assert.ok(!names.includes('能力索引'), 'goal 不含 main 派目标 skill');
});

test('T3 · 感知(both)两个子集都有 → 不削弱', () => {
  const r = build();
  assert.ok(r.subsetForAgent('main').indexEntries().some(e => e.name === '感知世界'));
  assert.ok(r.subsetForAgent('goal').indexEntries().some(e => e.name === '感知世界'));
});

test('T4 · 缺省标签视为 both（两者都有）', () => {
  const r = build();
  assert.ok(r.subsetForAgent('main').indexEntries().some(e => e.name === '老skill无标签'));
  assert.ok(r.subsetForAgent('goal').indexEntries().some(e => e.name === '老skill无标签'));
});
