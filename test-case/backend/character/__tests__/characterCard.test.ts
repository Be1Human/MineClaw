import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterTemplate } from '../../../../apps/minecraft-companion/src/character/templates.js';
import { validateCharacterCard } from '../../../../apps/minecraft-companion/src/character/validateCharacterCard.js';
import { resolveCharacterCard } from '../../../../apps/minecraft-companion/src/character/migrateCharacterCard.js';
import { selectWorldBookEntries } from '../../../../apps/minecraft-companion/src/character/worldBookSelector.js';
import { assembleCharacterPrompt } from '../../../../apps/minecraft-companion/src/character/characterPromptAssembler.js';
import { explicitUserName, stripGenericUserVocative } from '../../../../apps/minecraft-companion/src/character/userAddressing.js';

describe('FEAT-CROSS-12 · CharacterCard v1', () => {
  it('四部分模板通过校验', () => {
    for (const id of ['real_world_friend', 'minecraft_native'] as const) {
      const card = createCharacterTemplate(id, { characterName: '兰依', userName: 'qxy' });
      assert.deepEqual(Object.keys(card).sort(), ['character', 'performance', 'relationship', 'schemaVersion', 'world']);
      assert.deepEqual(validateCharacterCard(card), []);
      assert.deepEqual(card.performance.proactiveCapabilities, {});
    }
  });

  it('旧 Profile 无损迁移名字、人设、风格和用户身份', () => {
    const card = resolveCharacterCard({
      name: 'LanYi', ownerUsername: 'qxy',
      personality: { description: '喜欢冒险', style: '俏皮' },
    });
    assert.equal(card.character.identity.name, 'LanYi');
    assert.equal(card.character.personality.summary, '喜欢冒险');
    assert.equal(card.character.personality.speechStyle, '俏皮');
    assert.equal(card.relationship.userPersona.name, 'qxy');
  });

  it('世界书只选常驻和关键词命中项，排序与预算稳定', () => {
    const card = createCharacterTemplate('minecraft_native');
    card.world.worldBook = [
      { id: 'b', title: '矿洞', content: '矿洞在北边', enabled: true, keywords: ['矿洞'], priority: 2 },
      { id: 'a', title: '规则', content: '村庄禁止偷窃', enabled: true, constant: true, keywords: [], priority: 1 },
      { id: 'c', title: '下界', content: '下界门在南边', enabled: true, keywords: ['下界'], priority: 9 },
    ];
    assert.deepEqual(selectWorldBookEntries(card.world.worldBook, '去矿洞看看').map(item => item.id), ['a', 'b']);
    assert.deepEqual(selectWorldBookEntries(card.world.worldBook, '去矿洞看看', 14).map(item => item.id), []);
  });

  it('原住民 Prompt 不把 Minecraft 当游戏，并包含四个部分', () => {
    const prompt = assembleCharacterPrompt(createCharacterTemplate('minecraft_native', { userName: 'qxy' }), '你从哪里来');
    assert.match(prompt, /【角色本身】/);
    assert.match(prompt, /【关系与用户】/);
    assert.match(prompt, /【世界与场景】/);
    assert.match(prompt, /【表演与能力】/);
    assert.match(prompt, /这里不是游戏/);
    assert.match(prompt, /不知道 AI、模型、API/);
  });

  it('BUG-CROSS-65 · 通用关系标签不冒充用户名，句首通用呼语被窄清理', () => {
    const card = createCharacterTemplate('real_world_friend', { userName: '朋友' });
    const prompt = assembleCharacterPrompt(card, '任务完成了吗');
    assert.match(prompt, /用户：未设置具体称呼/);
    assert.match(prompt, /不要把“朋友、玩家、用户、对方”/);
    assert.equal(explicitUserName('朋友'), null);
    assert.equal(explicitUserName('cloudboyboy'), 'cloudboyboy');
    assert.equal(stripGenericUserVocative('朋友，任务完成了'), '任务完成了');
    assert.equal(stripGenericUserVocative('我们是朋友，任务也完成了'), '我们是朋友，任务也完成了');
  });

  it('非法版本、重复世界书 ID 和缺失能力被拒绝', () => {
    const card = createCharacterTemplate('real_world_friend') as any;
    card.schemaVersion = 2;
    assert.match(validateCharacterCard(card)[0]?.message ?? '', /仅支持/);
    card.schemaVersion = 1;
    card.world.worldBook = [
      { id: 'same', title: 'A', content: 'A', enabled: true, keywords: [], priority: 1 },
      { id: 'same', title: 'B', content: 'B', enabled: true, keywords: [], priority: 1 },
    ];
    delete card.performance.capabilities.minecraft;
    const errors = validateCharacterCard(card);
    assert.ok(errors.some(error => error.path.endsWith('.id') && /不可重复/.test(error.message)));
    assert.ok(errors.some(error => error.path === 'performance.capabilities.minecraft'));
  });

  it('FEAT-CROSS-18 · 进展汇报默认 balanced，旧卡兼容且非法档位被拒绝', () => {
    const card = createCharacterTemplate('real_world_friend');
    assert.equal(card.performance.progressReportLevel, 'balanced');
    delete card.performance.progressReportLevel;
    assert.deepEqual(validateCharacterCard(card), []);
    (card.performance as { progressReportLevel?: string }).progressReportLevel = 'always';
    assert.ok(validateCharacterCard(card).some(error => error.path === 'performance.progressReportLevel'));
  });

  it('FEAT-CROSS-25 · 主动能力配置按通用映射迁移并校验', () => {
    const legacy = createCharacterTemplate('real_world_friend');
    delete legacy.performance.proactiveCapabilities;
    const migrated = resolveCharacterCard({ name: 'LanYi', characterCard: legacy });
    assert.deepEqual(migrated.performance.proactiveCapabilities, {});

    migrated.performance.proactiveCapabilities = {
      auto_follow: { enabled: true, config: { graceMs: 5_000, quiet: true, mode: 'safe' } },
      future_plugin: { enabled: false },
    };
    assert.deepEqual(validateCharacterCard(migrated), []);

    migrated.performance.proactiveCapabilities.auto_follow!.config!.graceMs = Number.NaN;
    assert.ok(validateCharacterCard(migrated).some(error => (
      error.path === 'performance.proactiveCapabilities.auto_follow.config.graceMs'
    )));
  });
});
