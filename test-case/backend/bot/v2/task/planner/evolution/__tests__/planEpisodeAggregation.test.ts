import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlannerLeafEpisode } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { latestPlanEpisodes, logicalPlanNodeId } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/planEpisodeAggregation.js';

test('FEAT-CROSS-14-006-010 | 图重规划的新运行 ID 仍聚合为同一逻辑节点', () => {
  assert.equal(logicalPlanNodeId('node-1'), 'node-1');
  assert.equal(logicalPlanNodeId('node-1~r2'), 'node-1');
  assert.equal(logicalPlanNodeId('node-1~r2~r3'), 'node-1');

  const failed = episode('leaf-r1', 'node-1', 1, 'finalized', 'failed');
  const running = episode('leaf-r2', 'node-1~r2', 2, 'open');
  assert.deepEqual(latestPlanEpisodes([failed, running]).map(value => value.sessionId), ['leaf-r2']);
});

test('FEAT-CROSS-14-006-010 | 不相关节点保留各自最新 revision', () => {
  const episodes = [
    episode('a-r1', 'a', 1, 'finalized', 'succeeded'),
    episode('b-r1', 'b', 1, 'finalized', 'failed'),
    episode('b-r2', 'b~r2', 2, 'finalized', 'succeeded'),
  ];
  assert.deepEqual(latestPlanEpisodes(episodes).map(value => value.sessionId), ['a-r1', 'b-r2']);
});

function episode(
  sessionId: string,
  nodeId: string,
  planRevision: number,
  state: PlannerLeafEpisode['state'],
  outcome?: PlannerLeafEpisode['outcome'],
): PlannerLeafEpisode {
  return {
    sessionId,
    runId: 'plan',
    planRunId: 'plan',
    planRevision,
    nodeId,
    state,
    firstSequence: 1,
    lastContiguousSequence: 1,
    maxSequence: 1,
    ...(outcome ? { outcome } : {}),
    facts: [],
  };
}
