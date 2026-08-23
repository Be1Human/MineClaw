import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GoalAgentSkillKnowledgeAdapter,
  goalAgentSkillRef,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/goalAgentSkillKnowledge.js';
import { AgentSkillRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillRegistry.js';
import type { AgentSkill } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/types.js';

function skill(input: {
  name: string;
  agent?: 'main' | 'goal' | 'both';
  description?: string;
  triggers?: string[];
  uses?: string[];
  body?: string;
  category?: string;
}): AgentSkill {
  return {
    meta: {
      name: input.name,
      description: input.description ?? `${input.name} workflow`,
      agent: input.agent,
      triggers: input.triggers ?? [],
      uses: input.uses ?? [],
      category: input.category,
    },
    body: input.body ?? `# ${input.name}\n1. inspect\n2. execute`,
    dir: `/skills/${input.name}`,
    source: 'local',
  };
}

function adapter(...skills: AgentSkill[]): GoalAgentSkillKnowledgeAdapter {
  const registry = new AgentSkillRegistry(() => {});
  for (const value of skills) registry.register(value);
  return new GoalAgentSkillKnowledgeAdapter(registry);
}

test('BUG-CROSS-73-004 · search returns only bounded goal/both index evidence without bodies', () => {
  const knowledge = adapter(
    skill({ name: '合成造物', agent: 'goal', triggers: ['合成', '制作'], uses: ['craft_item'], body: 'secret goal body' }),
    skill({ name: '感知世界', agent: 'both', triggers: ['查看'] }),
    skill({ name: '能力索引', agent: 'main', triggers: ['合成'], body: 'secret main body' }),
  );
  const found = knowledge.search({ query: '合成石镐', objective: 'plan', limit: 5 });
  assert.deepEqual(found.map(value => value.name), ['合成造物']);
  assert.deepEqual(found[0]?.uses, ['craft_item']);
  assert.match(found[0]?.ref ?? '', /^skill:[a-f0-9]{24}$/);
  assert.match(found[0]?.version ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(found[0]?.evidenceRef ?? '', /^skill:.*@sha256:/);
  assert.equal('body' in (found[0] ?? {}), false);
  assert.equal(JSON.stringify(found).includes('secret'), false);
});

test('BUG-CROSS-73-005 · catalog exposes bounded goal/both summaries without Skill bodies', () => {
  const knowledge = adapter(
    skill({ name: '跟随主人', agent: 'goal', description: '靠近并跟随主人', body: 'SECRET FOLLOW BODY' }),
    skill({ name: '人格表达', agent: 'main', description: '聊天人格', body: 'SECRET MAIN BODY' }),
  );
  const catalog = knowledge.catalog({ limit: 10 });
  assert.deepEqual(catalog.map(value => value.name), ['跟随主人']);
  assert.equal(catalog[0]?.score, 0);
  assert.equal('body' in (catalog[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET/);
});

test('BUG-CROSS-73-004 · get returns exactly one complete versioned Skill document', () => {
  const knowledge = adapter(skill({
    name: '采集材料', agent: 'goal', triggers: ['采集'], uses: ['gather'], body: 'inspect then gather',
  }));
  const [index] = knowledge.search({ query: '采集木头', objective: 'act', limit: 3 });
  assert.ok(index);
  const result = knowledge.get({ ref: index.ref, expectedVersion: index.version });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.body, 'inspect then gather');
  assert.equal(result.skill.contentHash, index.version);
  assert.equal(result.skill.evidenceRef, index.evidenceRef);
  assert.ok(result.skill.estimatedTokens > 0);
});

test('BUG-CROSS-73-004 · exact get cannot reveal an agent=main Skill', () => {
  const knowledge = adapter(skill({ name: '任务管理', agent: 'main', triggers: ['停止'] }));
  assert.deepEqual(knowledge.search({ query: '停止任务', objective: 'understand', limit: 5 }), []);
  assert.deepEqual(knowledge.get({ ref: goalAgentSkillRef('任务管理') }), {
    ok: false, reason: 'not_found', ref: goalAgentSkillRef('任务管理'),
  });
});

test('BUG-CROSS-73-004 · missing, stale and corrupt refs fail closed with typed reasons', () => {
  const valid = skill({ name: '探索找路', agent: 'goal', triggers: ['探索'] });
  const corrupt = skill({ name: '损坏技能', agent: 'goal', body: ' ' });
  const knowledge = adapter(valid, corrupt);
  const validRef = goalAgentSkillRef(valid.meta.name);
  assert.deepEqual(knowledge.get({ ref: 'skill:missing' }), {
    ok: false, reason: 'not_found', ref: 'skill:missing',
  });
  const stale = knowledge.get({ ref: validRef, expectedVersion: 'sha256:old' });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.reason, 'stale');
    assert.match(stale.actualVersion ?? '', /^sha256:/);
  }
  assert.deepEqual(knowledge.get({ ref: goalAgentSkillRef(corrupt.meta.name) }), {
    ok: false, reason: 'corrupt', ref: goalAgentSkillRef(corrupt.meta.name),
  });
});

test('BUG-CROSS-73-004 · document reads enforce a hard token budget', () => {
  const value = skill({ name: '大型流程', agent: 'goal', triggers: ['大型'], body: 'x'.repeat(400) });
  const knowledge = adapter(value);
  assert.deepEqual(knowledge.get({ ref: goalAgentSkillRef(value.meta.name), maxTokens: 10 }), {
    ok: false,
    reason: 'budget_exceeded',
    ref: goalAgentSkillRef(value.meta.name),
    estimatedTokens: 100,
    maxTokens: 10,
  });
});

test('BUG-CROSS-73-004 · ranking uses goal, active step and failure context and remains Top-K', () => {
  const values = Array.from({ length: 50 }, (_, index) => skill({
    name: `无关流程${index}`, agent: 'goal', triggers: [`无关${index}`], body: 'do something',
  }));
  values.push(skill({
    name: '容器取物恢复', agent: 'goal', description: '箱子路径失败时重新定位容器',
    triggers: ['箱子', '路径'], category: 'task',
  }));
  const found = adapter(...values).search({
    query: '继续任务', objective: 'recover', goalSignature: '从箱子取铁镐',
    activeStep: 'withdraw_from_chest', failureCode: 'atomic.path', limit: 3,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, '容器取物恢复');
});

test('BUG-CROSS-73-004 · stable ref survives content updates while version changes', () => {
  const before = skill({ name: '合成造物', agent: 'goal', triggers: ['合成'], body: 'v1' });
  const after = skill({ name: '合成造物', agent: 'goal', triggers: ['合成'], body: 'v2' });
  const first = adapter(before).search({ query: '合成', objective: 'plan', limit: 1 })[0]!;
  const second = adapter(after).search({ query: '合成', objective: 'plan', limit: 1 })[0]!;
  assert.equal(first.ref, second.ref);
  assert.notEqual(first.version, second.version);
});
