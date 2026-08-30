import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/components/MemoryPanel.vue', import.meta.url),
  'utf8',
);

test('记忆控制台区分官方槽位与模型发现，并默认隐藏空槽位', () => {
  assert.match(source, /常用记忆槽/);
  assert.match(source, /模型发现/);
  assert.match(source, /filledCount/);
  assert.match(source, /totalSlots/);
  assert.match(source, /const showEmptySlots = ref\(false\)/);
  assert.match(source, /候选不会参与普通召回/);
});

test('记忆控制台提供槽位治理、动态候选治理和旧数据迁移入口', () => {
  for (const contract of [
    '/slots',
    '/slot-values/',
    '/map-to-slot',
    '/slot-migration/apply',
  ]) {
    assert.match(source, new RegExp(contract.replaceAll('/', '\\/')));
  }
  assert.match(source, /factAction\(fact, 'approve'/);
  assert.match(source, /factAction\(fact, 'reject'/);
  for (const action of ['填写', '来源', '清空', '批准', '拒绝', '映射到槽位', '整理旧记忆']) {
    assert.match(source, new RegExp(action));
  }
});

test('记忆控制台只使用主题中存在的颜色变量', () => {
  assert.doesNotMatch(source, /--mc-surface-soft|--mc-text-faint/);
  assert.match(source, /--mc-surface-raised/);
  assert.match(source, /--mc-text-muted/);
});
