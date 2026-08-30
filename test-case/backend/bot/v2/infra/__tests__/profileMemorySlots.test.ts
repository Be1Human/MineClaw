import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ChatMemoryService } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import {
  MEMORY_SLOT_CATALOG,
  classifyOwnerMemorySpeech,
  getMemorySlotDefinition,
  searchMemorySlotDefinitions,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/memory/profileSlots/index.js';

describe('official profile memory slots', () => {
  it('publishes exactly 100 unique, valid v1 slot definitions', () => {
    assert.equal(MEMORY_SLOT_CATALOG.length, 100);
    assert.equal(new Set(MEMORY_SLOT_CATALOG.map(slot => slot.slotKey)).size, 100);
    assert.ok(MEMORY_SLOT_CATALOG.every(slot => slot.catalogVersion === 1));
    assert.equal(getMemorySlotDefinition('preference.food.favorite')?.title, '喜欢的食物');
    assert.equal(searchMemorySlotDefinitions('我喜欢吃什么', 8)[0]?.slotKey, 'preference.food.favorite');
    assert.equal(classifyOwnerMemorySpeech('我现在不喜欢吃鱼了，更喜欢吃虾'), 'statement');
    assert.equal(classifyOwnerMemorySpeech('我现在有点饿'), 'temporary');
  });

  it('keeps empty slots sparse and stores sourced set values idempotently', () => withMemory(memory => {
    assert.equal(memory.getMemorySlotCatalog().length, 100);
    assert.equal(memory.getMemorySlotCatalog({ filledOnly: true }).length, 0);
    assert.equal(memory.countActiveMemorySlots(), 0);

    memory.recordMessage({ id: 'm1', sessionId: 's1', role: 'owner', content: '我喜欢吃鱼', timestamp: 1 });
    const first = memory.putMemorySlotValue({
      slotKey: 'preference.food.favorite',
      value: '鱼',
      sourceKind: 'conversation',
      sourceMessageIds: ['m1'],
    });
    assert.ok(!('rejected' in first));

    memory.recordMessage({ id: 'm2', sessionId: 's2', role: 'owner', content: '鱼我还是很喜欢', timestamp: 2 });
    const duplicate = memory.putMemorySlotValue({
      slotKey: 'preference.food.favorite',
      value: '鱼',
      sourceKind: 'conversation',
      sourceMessageIds: ['m2'],
    });
    assert.ok(!('rejected' in duplicate));
    assert.equal(duplicate.id, first.id);
    assert.deepEqual(duplicate.sourceMessageIds, ['m1', 'm2']);
    assert.equal(memory.getMemorySlotCatalog({ filledOnly: true }).length, 1);
    assert.equal(memory.countActiveMemorySlots(), 1);
  }));

  it('versions scalar values and supports delete and restore without losing evidence', () => withMemory(memory => {
    memory.recordMessage({ id: 'm1', sessionId: 's', role: 'owner', content: '叫我小蓝', timestamp: 1 });
    const first = memory.putMemorySlotValue({
      slotKey: 'identity.preferred_name', value: '小蓝', sourceKind: 'conversation', sourceMessageIds: ['m1'],
    });
    assert.ok(!('rejected' in first));

    memory.recordMessage({ id: 'm2', sessionId: 's', role: 'owner', content: '以后叫我蓝一', timestamp: 2 });
    const second = memory.putMemorySlotValue({
      slotKey: 'identity.preferred_name', value: '蓝一', sourceKind: 'conversation', sourceMessageIds: ['m2'],
    });
    assert.ok(!('rejected' in second));
    assert.equal(second.supersedesId, first.id);
    assert.equal(memory.getMemorySlotValues({ slotKey: 'identity.preferred_name', status: 'active' })[0]?.value, '蓝一');
    assert.equal(memory.getMemorySlotValues({ slotKey: 'identity.preferred_name', status: 'superseded' })[0]?.value, '小蓝');

    assert.equal(memory.removeMemorySlotValue(second.id), true);
    assert.equal(memory.countActiveMemorySlots(), 0);
    const restored = memory.restoreMemorySlotValue(second.id);
    assert.equal(restored?.value, '蓝一');
    assert.deepEqual(restored?.sourceMessageIds, ['m2']);
  }));

  it('requires explicit evidence for sensitive slots and rejects cross-profile sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-slots-'));
    const dbPath = join(dir, 'memory.db');
    const a = new ChatMemoryService({ dbPath, profileId: 'a', autoCapture: false });
    const b = new ChatMemoryService({ dbPath, profileId: 'b', autoCapture: false });
    try {
      a.recordMessage({ id: 'a1', sessionId: 's', role: 'owner', content: '我对花生过敏', timestamp: 1 });
      assert.deepEqual(a.putMemorySlotValue({
        slotKey: 'preference.food.allergy', value: '花生', sourceKind: 'conversation', sourceMessageIds: ['a1'],
      }), { rejected: 'explicit_capture_required' });
      assert.deepEqual(b.putMemorySlotValue({
        slotKey: 'preference.food.favorite', value: '鱼', sourceKind: 'conversation', sourceMessageIds: ['a1'],
      }), { rejected: 'owner_evidence_outside_profile' });
      const explicit = a.putMemorySlotValue({
        slotKey: 'preference.food.allergy', value: '花生', sourceKind: 'explicit_tool', sourceMessageIds: ['a1'],
      });
      assert.ok(!('rejected' in explicit));
      assert.equal(b.getMemorySlotCatalog({ filledOnly: true }).length, 0);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists sparse values across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-slots-reopen-'));
    const dbPath = join(dir, 'memory.db');
    const first = new ChatMemoryService({ dbPath, profileId: 'p', autoCapture: false });
    first.recordMessage({ id: 'm1', sessionId: 's', role: 'owner', content: '我喜欢吃鱼', timestamp: 1 });
    first.putMemorySlotValue({ slotKey: 'preference.food.favorite', value: '鱼', sourceKind: 'conversation', sourceMessageIds: ['m1'] });
    first.close();
    const reopened = new ChatMemoryService({ dbPath, profileId: 'p', autoCapture: false });
    try {
      assert.equal(reopened.getMemorySlotCatalog({ filledOnly: true })[0]?.values[0]?.value, '鱼');
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supersedes only the conflicting element when a set preference flips polarity', () => withMemory(memory => {
    memory.recordMessage({ id: 'like-fish', sessionId: 's', role: 'owner', content: '我喜欢吃鱼', timestamp: 1 });
    memory.recordMessage({ id: 'like-beef', sessionId: 's', role: 'owner', content: '我喜欢吃牛肉', timestamp: 2 });
    memory.recordMessage({ id: 'dislike-fish', sessionId: 's', role: 'owner', content: '我不喜欢吃鱼', timestamp: 3 });
    memory.putMemorySlotValue({ slotKey: 'preference.food.favorite', value: '鱼', sourceKind: 'conversation', sourceMessageIds: ['like-fish'] });
    memory.putMemorySlotValue({ slotKey: 'preference.food.favorite', value: '牛肉', sourceKind: 'conversation', sourceMessageIds: ['like-beef'] });
    memory.putMemorySlotValue({ slotKey: 'preference.food.dislike', value: '鱼', sourceKind: 'conversation', sourceMessageIds: ['dislike-fish'] });

    assert.deepEqual(
      memory.getMemorySlotValues({ status: 'active', slotKey: 'preference.food.favorite' }).map(value => value.value),
      ['牛肉'],
    );
    assert.deepEqual(
      memory.getMemorySlotValues({ status: 'active', slotKey: 'preference.food.dislike' }).map(value => value.value),
      ['鱼'],
    );
    assert.equal(memory.getMemorySlotValues({ status: 'superseded', slotKey: 'preference.food.favorite' })[0]?.value, '鱼');
  }));

  it('injects only relevant official slots before dynamic facts and previews safe legacy migration', () => withMemory(memory => {
    memory.recordMessage({ id: 'food', sessionId: 's', role: 'owner', content: '我喜欢吃鱼', timestamp: 1 });
    memory.putMemorySlotValue({ slotKey: 'preference.food.favorite', value: '鱼', sourceKind: 'conversation', sourceMessageIds: ['food'] });
    memory.addFact({ scope: 'user', kind: 'preference', text: '我喜欢吃鱼', confidence: 0.8, importance: 0.7, sourceMessageIds: ['food'] });
    memory.recordMessage({ id: 'music', sessionId: 's', role: 'owner', content: '我喜欢爵士音乐', timestamp: 2 });
    memory.putMemorySlotValue({ slotKey: 'preference.music.genre', value: '爵士', sourceKind: 'conversation', sourceMessageIds: ['music'] });

    const context = memory.buildPromptContext('我喜欢吃什么');
    assert.match(context.text, /官方记忆槽（喜欢的食物）：鱼/);
    assert.doesNotMatch(context.text, /官方记忆槽（音乐类型）/);
    assert.equal(context.retrievedSlotValueIds.length, 1);
    assert.equal(context.retrievedFactIds.length, 0, 'covered legacy fact must not be injected twice');

    memory.addFact({ scope: 'user', kind: 'preference', text: '我喜欢什么？', confidence: 0.7, importance: 0.6, sourceMessageIds: ['food'] });
    const preview = memory.previewLegacyFactSlotMigration();
    assert.ok(preview.some(item => item.outcome === 'official_slot' && item.slotKey === 'preference.food.favorite'));
    assert.ok(preview.some(item => item.outcome === 'rejected' && item.reason === 'question'));
    assert.equal(memory.applyLegacyFactSlotMigration().migrated, 1);
  }));
});

function withMemory(run: (memory: ChatMemoryService) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-slots-'));
  const memory = new ChatMemoryService({ dbPath: join(dir, 'memory.db'), profileId: 'p', autoCapture: false });
  try { run(memory); } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
