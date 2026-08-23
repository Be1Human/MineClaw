import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompanionCore } from '../../../../../../apps/minecraft-companion/src/bot/v2/companion/companionCore.js';

// Asia/Hong_Kong（UTC+8）本地 09:00，用于验证静默时段按用户本地小时判断。
function createCore(now = () => Date.UTC(2026, 6, 26, 1, 0, 0)): CompanionCore {
  return new CompanionCore({
    profileId: 'profile-a',
    corePersona: {
      id: 'core-a', version: 1,
      traits: ['平和', '诚实'], boundaries: ['不操纵用户', '不把推断当事实'],
    },
    now,
  });
}

describe('CompanionCore', () => {
  it('TC-COMP-01：Overlay 不会改写核心人格，且要求来源', () => {
    const core = createCore();
    assert.throws(() => core.applyPersonaOverlay({ id: 'o1', changes: ['更简短'], sourceIds: [] }));
    core.applyPersonaOverlay({ id: 'o1', changes: ['更简短'], sourceIds: ['chat-1'] });
    assert.deepEqual(core.getCorePersona().traits, ['平和', '诚实']);
    assert.match(core.toPromptContext(), /更简短/);
  });

  it('TC-COMP-02：回滚指定版本之后的 Overlay', () => {
    const core = createCore();
    core.applyPersonaOverlay({ id: 'o1', changes: ['更简短'], sourceIds: ['chat-1'] });
    core.applyPersonaOverlay({ id: 'o2', changes: ['称呼小名'], sourceIds: ['chat-2'] });
    core.rollbackOverlaysAfter(1);
    const prompt = core.toPromptContext();
    assert.match(prompt, /更简短/);
    assert.doesNotMatch(prompt, /称呼小名/);
  });

  it('TC-COMP-03：关系变化按单次 delta 限幅并记录来源', () => {
    const core = createCore();
    const state = core.applyRelationshipEvidence({ evidenceId: 'chat-1', trustDelta: 0.9, familiarityDelta: -0.9 });
    assert.equal(state.trust, 0.1);
    assert.equal(state.familiarity, -0.1);
    assert.deepEqual(state.evidenceIds, ['chat-1']);
  });

  it('TC-COMP-04：用户纠正后情绪候选退出 Prompt', () => {
    const core = createCore();
    core.observeEmotion({ id: 'e1', label: '难过', confidence: 0.9, evidence: ['chat-1'], alternatives: ['疲惫'] });
    assert.match(core.toPromptContext(), /难过/);
    core.correctEmotion('e1', '用户明确否定');
    assert.doesNotMatch(core.toPromptContext(), /难过/);
    assert.equal(core.exportState().emotions[0]?.state, 'corrected');
  });

  it('TC-COMP-05：主动性依次被开关、静默、预算与冷却拦截', () => {
    let clock = Date.UTC(2026, 6, 26, 1, 0, 0);
    const core = createCore(() => clock);
    assert.equal(core.decideInitiative().reason, 'disabled');
    core.setInitiativePolicy({ enabled: true, quietHours: { start: 9, end: 10 }, cooldownMs: 1000, dailyBudget: 1 });
    assert.equal(core.decideInitiative().reason, 'quiet_hours');
    clock = Date.UTC(2026, 6, 26, 2, 0, 0);
    assert.equal(core.recordInitiative().reason, 'allowed');
    assert.equal(core.decideInitiative().reason, 'budget');
    core.setInitiativePolicy({ dailyBudget: 2 });
    assert.equal(core.decideInitiative().reason, 'cooldown');
  });

  it('TC-COMP-06：状态导出始终受 Profile 作用域约束', () => {
    const state = createCore().exportState();
    assert.equal(state.profileId, 'profile-a');
    assert.equal(state.corePersona.id, 'core-a');
  });
});
