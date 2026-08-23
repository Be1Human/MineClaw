import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_INTERACTION_RANGE,
  isGatherCandidateEligible,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/gatherStrategy.js';

const candidate = { x: 1048, y: 120, z: 1040 };
const key = '1048,120,1040';

test('BUG-CROSS-31 · 未拉黑候选保持可用', () => {
  assert.equal(
    isGatherCandidateEligible(candidate, { x: 1000, y: 120, z: 1000 }, new Map()),
    true,
  );
});

test('BUG-CROSS-31 · 已移动到直接交互距离后绕过旧位置黑名单', () => {
  const blacklist = new Map([[key, Date.now() + 30_000]]);
  assert.equal(
    isGatherCandidateEligible(candidate, { x: 1048.5, y: 121, z: 1040.5 }, blacklist),
    true,
  );
});

test('BUG-CROSS-31 · 远处黑名单继续生效', () => {
  const blacklist = new Map([[key, Date.now() + 30_000]]);
  assert.equal(
    isGatherCandidateEligible(
      candidate,
      { x: candidate.x - DIRECT_INTERACTION_RANGE - 0.1, y: candidate.y, z: candidate.z },
      blacklist,
    ),
    false,
  );
});
