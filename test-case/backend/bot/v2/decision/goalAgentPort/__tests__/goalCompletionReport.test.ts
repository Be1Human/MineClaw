import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCompletedGoalSummary } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalCompletionReport.js';

describe('Goal completion report', () => {
  it('separates verified root criteria from unverified execution process', () => {
    const summary = buildCompletedGoalSummary({
      detail: 'verified criterion:entity_dead:zombie',
      evidenceRefs: ['criterion:entity_dead:zombie'],
    });
    assert.match(summary, /criterion:entity_dead:zombie/);
    assert.match(summary, /仅确认目标终态/);
    assert.match(summary, /没有可用于描述具体武器、进食、受伤或方块变化的过程证据/);
  });
});
