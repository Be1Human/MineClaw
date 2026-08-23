import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ChatMemoryRecallProvider,
  EpisodeAssembler,
  EpisodeStore,
  MemoryCatalog,
  MemorySystem,
  canonicalMemoryId,
  type MemoryKind,
  type MemoryRecord,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/memory/index.js';
import { ChatMemoryService } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';

describe('MemorySystem unified recall', () => {
  test('uses the current query, retains P0/P1, and recalls a matching episode with evidence', () => {
    const catalog = new MemoryCatalog(':memory:');
    const episodes = new EpisodeStore(':memory:');
    const profileId = 'profile-a';
    catalog.applySourceBatch('fixture', profileId, {
      records: [
        record(profileId, 'boundary', '不要擅自破坏主人的建筑', 1, 1),
        record(profileId, 'commitment', '答应下次带主人去村庄', 0.9, 2),
        record(profileId, 'preference', '主人喜欢蓝色羊毛', 0.7, 3),
      ],
      nextCursor: null,
      exhausted: true,
      sourceCount: 3,
    });
    const assembler = new EpisodeAssembler(episodes);
    assembler.accept({
      observationId: 'event-start', profileId, kind: 'combat', phase: 'started', timestamp: 100,
      correlationId: 'combat-1', locationRef: '村庄北门', eventSummary: '在村庄北门遭到僵尸袭击',
      participants: [{ id: 'owner', kind: 'owner' }, { id: 'zombie', kind: 'mob' }],
      snapshot: {
        timestamp: 100, nearestLandmark: '村庄北门', nearbyHostiles: ['zombie'], hazards: [], health: 20,
        sourceEventIds: ['bus:event-start'],
      },
      sourceRefs: [{ store: 'event-bus', id: 'event-start' }],
    });
    assembler.accept({
      observationId: 'event-end', profileId, kind: 'combat', phase: 'terminal', timestamp: 160,
      correlationId: 'combat-1', locationRef: '村庄北门', eventSummary: '击退僵尸后安全脱身', outcome: 'survived',
      sourceRefs: [{ store: 'event-bus', id: 'event-end' }],
    });

    const system = new MemorySystem(profileId, catalog, episodes);
    const prepared = system.prepareContext('上次打僵尸好惊险呀', 500);
    assert.equal(prepared.trace.query, '上次打僵尸好惊险呀');
    assert.match(prepared.text, /僵尸/);
    assert.match(prepared.text, /不要擅自破坏/);
    assert.match(prepared.text, /答应下次/);
    assert.ok(prepared.trace.selected.some(item => item.priority === 'P0'));
    assert.ok(prepared.trace.selected.some(item => item.priority === 'P1'));
    const tinyBudget = system.prepareContext('完全不相关的问题', 10);
    assert.match(tinyBudget.text, /不要擅自破坏/);
    assert.match(tinyBudget.text, /答应下次/);

    const deep = system.deepRecall({ query: '村庄北门的僵尸', locations: ['村庄北门'] });
    assert.equal(deep.episodes.length, 1);
    assert.equal(deep.episodes[0]?.outcome, 'survived');
    assert.ok(deep.evidence.some(item => item.ref.id === 'event-start'));
    assert.ok(system.trace(deep.traceId));

    assert.throws(
      () => system.recall({ profileId: 'profile-b', query: '僵尸', mode: 'auto', budget: 500 }),
      /profile mismatch/,
    );
    episodes.close();
    catalog.close();
  });

  test('reports an explicit gap instead of inventing a memory', () => {
    const catalog = new MemoryCatalog(':memory:');
    const episodes = new EpisodeStore(':memory:');
    const system = new MemorySystem('profile-a', catalog, episodes);
    const result = system.deepRecall({ query: '从未发生过的末地龙庆典' });
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.episodes, []);
    assert.equal(result.gaps.length, 1);
    episodes.close();
    catalog.close();
  });

  test('projects a planner-only view without leaking unrelated conversation text', () => {
    const catalog = new MemoryCatalog(':memory:');
    const episodes = new EpisodeStore(':memory:');
    const profileId = 'profile-a';
    const boundary = record(profileId, 'boundary', '不要破坏村庄建筑', 1, 1);
    const privateChat = record(profileId, 'conversation', '用户私聊内容：银行卡提示词', 1, 2);
    const lesson = {
      ...record(profileId, 'task_experience', '低血量时先撤退再反击', 0.8, 3),
      confidence: 0.75,
      metadata: { lesson: true },
    };
    catalog.applySourceBatch('fixture', profileId, {
      records: [boundary, privateChat, lesson], nextCursor: null, exhausted: true, sourceCount: 3,
    });
    const assembler = new EpisodeAssembler(episodes);
    assembler.accept({
      observationId: 'danger-start', profileId, kind: 'danger', phase: 'started', timestamp: 100,
      locationRef: '村庄', eventSummary: '低血量遭遇僵尸', lessonCandidates: ['保持撤退路线'],
      sourceRefs: [{ store: 'event-bus', id: 'danger-start' }],
    });
    assembler.accept({
      observationId: 'danger-end', profileId, kind: 'danger', phase: 'terminal', timestamp: 120,
      locationRef: '村庄', eventSummary: '撤退成功', outcome: 'survived',
      sourceRefs: [{ store: 'event-bus', id: 'danger-end' }],
    });

    const system = new MemorySystem(profileId, catalog, episodes);
    const view = system.preparePlanningContext('去村庄打僵尸');
    assert.deepEqual(view.constraints.map(item => item.value), ['不要破坏村庄建筑']);
    assert.equal(view.knownRisks.length, 1);
    assert.ok(view.relevantLessons.some(item => item.value.description === '保持撤退路线' && item.status === 'candidate'));
    assert.equal(JSON.stringify(view).includes('银行卡提示词'), false);
    assert.ok(system.trace(view.traceId));
    episodes.close();
    catalog.close();
  });

  test('drops redundant summaries and exposes aggregate recall metrics', () => {
    const catalog = new MemoryCatalog(':memory:');
    const episodes = new EpisodeStore(':memory:');
    const profileId = 'profile-a';
    catalog.applySourceBatch('fixture', profileId, {
      records: [
        record(profileId, 'preference', '主人喜欢蓝色羊毛做装饰', 0.8, 1),
        record(profileId, 'conversation', '主人喜欢蓝色羊毛做装饰', 0.7, 2),
      ],
      nextCursor: null, exhausted: true, sourceCount: 2,
    });
    const system = new MemorySystem(profileId, catalog, episodes);
    const result = system.prepareContext('蓝色羊毛装饰');
    assert.equal(result.result.records.length, 1);
    assert.equal(result.trace.dropped.some(item => item.reason === 'redundant'), true);
    assert.deepEqual(system.stats().byMode, { auto: 1, deep: 0, planning: 0 });
    assert.equal(system.stats().recalls, 1);
    episodes.close();
    catalog.close();
  });

  test('sees newly written chat facts immediately without waiting for catalog backfill', () => {
    const catalog = new MemoryCatalog(':memory:');
    const episodes = new EpisodeStore(':memory:');
    const chat = new ChatMemoryService({ dbPath: ':memory:', profileId: 'profile-a', embeddingProvider: null });
    chat.addFact({
      scope: 'user', kind: 'boundary', text: '不要破坏村庄建筑', confidence: 1, importance: 1, sourceMessageIds: [],
    });
    chat.recordMessage({ id: 'm1', sessionId: 's', role: 'owner', content: '上次在村庄北门打过僵尸', timestamp: 100 });
    const system = new MemorySystem('profile-a', catalog, episodes, {
      liveProviders: [new ChatMemoryRecallProvider('profile-a', chat)],
    });

    assert.match(system.prepareContext('村庄北门').text, /上次在村庄北门打过僵尸/);
    assert.deepEqual(system.preparePlanningContext('去村庄').constraints.map(item => item.value), ['不要破坏村庄建筑']);
    assert.equal(catalog.count('profile-a'), 0, 'live recall must not mutate the rebuildable catalog');
    chat.close();
    episodes.close();
    catalog.close();
  });
});

function record(profileId: string, kind: MemoryKind, summary: string, importance: number, index: number): MemoryRecord {
  return {
    id: canonicalMemoryId(profileId, 'fixture', String(index)),
    profileId,
    kind,
    status: 'active',
    summary,
    occurredAt: index,
    createdAt: index,
    updatedAt: index,
    importance,
    confidence: 1,
    entities: [],
    locationRefs: [],
    sourceRefs: [{ store: 'fixture', id: String(index) }],
    evidenceRefs: [],
    metadata: {},
  };
}
