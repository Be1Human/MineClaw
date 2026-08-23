import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditLatestRelationGraph } from '../../../../benchmark/memory/external/memoryAgentBenchConflictAudit.js';

test('BUG-MEM-15 · 完整最新关系图可从问题实体到达多跳答案', () => {
  const result = auditLatestRelationGraph([
    '1. Mike D\'Antoni plays the position of point guard.',
    '2. point guard is associated with the sport of cricket.',
    '3. cricket was created in the country of England.',
    '4. The capital of England is London.',
  ].join('\n'), "Which city is the capital of the country where the sport Mike D'Antoni plays hails from?", ['London']);

  assert.equal(result.expectedReachable, true);
  assert.equal(result.rawExpectedPresent, true);
  assert.ok(result.traversedFactCount >= 4);
});

test('BUG-MEM-15 · 更大序号覆盖关系后，完整最新图不得重新到达旧答案', () => {
  const result = auditLatestRelationGraph([
    '1. Mike D\'Antoni plays the position of point guard.',
    '2. point guard is associated with the sport of cricket.',
    '3. cricket was created in the country of England.',
    '4. The capital of England is London.',
    '5. cricket was created in the country of Australia.',
    '6. The capital of Australia is Oderzo.',
  ].join('\n'), "Which city is the capital of the country where the sport Mike D'Antoni plays hails from?", ['London']);

  assert.equal(result.expectedReachable, false);
  assert.equal(result.rawExpectedPresent, true);
  assert.ok(result.reachedObjects.includes('Oderzo'));
});
