import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARDS } from '../../../../../../apps/minecraft-companion/src/bot/v2/bench/cards.js';
import { parseBenchCommand } from '../../../../../../apps/minecraft-companion/src/bot/v2/bench/benchCommand.js';

test('FEAT-CROSS-04：13 张阶梯任务卡覆盖 T0-T3', () => {
  assert.equal(TEST_CARDS.length, 13);
  for (const tier of ['T0', 'T1', 'T2', 'T3']) assert.ok(TEST_CARDS.some(card => card.tier === tier));
  assert.equal(new Set(TEST_CARDS.map(card => card.id)).size, TEST_CARDS.length);
});

test('FEAT-CROSS-04：#test 只精确拦截、可列卡、可中止、未知卡报错', () => {
  assert.deepEqual(parseBenchCommand('普通 #test walk_to_10'), { kind: 'not_bench' });
  assert.deepEqual(parseBenchCommand('#test list'), { kind: 'list' });
  assert.deepEqual(parseBenchCommand('#test abort'), { kind: 'abort' });
  assert.deepEqual(parseBenchCommand('#test walk_to_10'), { kind: 'run', cardId: 'walk_to_10' });
  assert.equal(parseBenchCommand('#test nope').kind, 'error');
});
