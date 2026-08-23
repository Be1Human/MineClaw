import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowestCostSuccessfulEpisode,
  repairResourceDemandContent,
  successfulResourceMilestones,
} from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/resourceDemandLearner.js';
import type { PlannerPolicyContent } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import type { PlannerLeafEpisode } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import {
  EXECUTION_FACT_SCHEMA_V1,
  type ExecutionFactEnvelopeV1,
} from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';

describe('FEAT-CROSS-14-006-016 · resource demand learning', () => {
  test('成功父图按累计消耗学习充分预算，而不是库存峰值或过采量', () => {
    const value = episode('success-budget', 'succeeded', [
      progress(2, { cobblestone: 8, raw_iron: 5, wooden_pickaxe: 1, seeds: 2 }),
      proposed(3, { action: 'craft', args: { itemName: 'stone_pickaxe' }, source: 'slow_llm' }),
      proposed(31, { action: 'invoke_behavior', args: { behaviorParams: { toolName: 'wooden_pickaxe' } }, source: 'slow_llm' }),
      progress(4, { cobblestone: -3 }),
      progress(5, { cobblestone: 4 }),
      proposed(6, { action: 'craft', args: { itemName: 'furnace' }, source: 'slow_llm' }),
      progress(7, { cobblestone: -8, raw_iron: -3 }),
      progress(8, { iron_pickaxe: 1 }),
    ]);

    const stages = successfulResourceMilestones(value, 'minecraft:iron_pickaxe');
    const cobble = stage(stages, 'cobblestone');
    const iron = stage(stages, 'raw_iron');
    assert.equal(cobble.structuredSuccessCriteria[0]?.count, 11);
    assert.equal(cobble.demandEvidence?.basis, 'success_consumption_budget');
    assert.equal(cobble.demandEvidence?.totalAcquired, 12);
    assert.equal(cobble.demandEvidence?.totalConsumed, 11);
    assert.equal(iron.structuredSuccessCriteria[0]?.count, 3, '过采 5 个原铁但只消费 3 个时应压缩为 3');
    assert.equal(stage(stages, 'wooden_pickaxe').structuredSuccessCriteria[0]?.count, 1);
    assert.equal(stages.some(value => value.stage === 'obtain:seeds'), false, '未消费且未引用的副产物不得进入计划');
    assert.equal(stages.some(value => value.stage === 'obtain:iron_pickaxe'), false, '最终目标不得重复成为中间阶段');
  });

  test('失败样本只保守提高已有阈值，不降低或凭空增加阶段', () => {
    const parent = policy();
    const failed = episode('failure-budget', 'failed', [
      progress(2, { cobblestone: 8, raw_iron: 5 }),
      progress(3, { cobblestone: -3 }),
      progress(4, { cobblestone: 4 }),
    ]);
    const repaired = repairResourceDemandContent(parent, [failed]);
    const schema = repaired.taskSchemas[0] as { stages: Array<Record<string, unknown>> };
    const cobble = schema.stages[0] as {
      structuredSuccessCriteria: Array<{ count: number }>;
      demandEvidence: { basis: string; totalAcquired: number };
    };
    const iron = schema.stages[1] as { structuredSuccessCriteria: Array<{ count: number }> };
    assert.equal(cobble.structuredSuccessCriteria[0]?.count, 12);
    assert.equal(cobble.demandEvidence.basis, 'failure_conservative_acquisition');
    assert.equal(cobble.demandEvidence.totalAcquired, 12);
    assert.equal(iron.structuredSuccessCriteria[0]?.count, 5, '失败证据不得把原铁 5 降为 3');
    assert.equal(schema.stages.length, 2, '失败证据不得凭空增加阶段');
    const fragment = repaired.planFragments[0] as { structuredSuccessCriteria: Array<{ count: number }> };
    assert.equal(fragment.structuredSuccessCriteria[0]?.count, 12, 'Schema 与 Fragment 必须同步修复');
  });

  test('多条成功样本选择整条低成本轨迹，不拼接局部最小值', () => {
    const slow = episode('slow-success', 'succeeded', [
      proposed(2, { action: 'get_inventory', args: {}, source: 'slow_llm' }),
      proposed(3, { action: 'locate_block', args: { name: 'stone' }, source: 'slow_llm' }),
      proposed(4, { action: 'gather', args: { itemName: 'cobblestone' }, source: 'slow_llm' }),
      progress(5, { cobblestone: 12 }),
      progress(6, { cobblestone: -11 }),
    ]);
    const fast = episode('fast-success', 'succeeded', [
      proposed(2, { action: 'gather', args: { itemName: 'cobblestone' }, source: 'fast_strategy' }),
      progress(3, { cobblestone: 11 }),
      progress(4, { cobblestone: -11 }),
    ]);
    assert.equal(lowestCostSuccessfulEpisode([slow, fast])?.sessionId, 'fast-success');
    assert.equal(lowestCostSuccessfulEpisode([fast, slow])?.sessionId, 'fast-success', '输入顺序不得影响结果');
  });
});

function policy(): PlannerPolicyContent {
  const stages = [
    milestone('cobblestone', 8),
    milestone('raw_iron', 5),
  ];
  return {
    taskSchemas: [{ id: 'schema:iron', stages }],
    planFragments: [{ id: 'fragment:cobble', ...milestone('cobblestone', 8) }],
    planRecoveryPatterns: [],
    metaPolicies: [],
    applicability: [],
  };
}

function milestone(item: string, count: number): Record<string, unknown> {
  const criterion = { type: 'inventory', item, count };
  return {
    stage: `obtain:${item}`,
    goalText: `获得至少 ${count} 个 ${item}，作为后续任务依赖`,
    structuredSuccessCriteria: [criterion],
    successCriteria: [criterion],
  };
}

function stage<T extends { stage: string }>(values: T[], item: string): T {
  const value = values.find(entry => entry.stage === `obtain:${item}`);
  assert.ok(value, `missing stage for ${item}`);
  return value;
}

function episode(
  sessionId: string,
  outcome: 'succeeded' | 'failed',
  body: ExecutionFactEnvelopeV1[],
): PlannerLeafEpisode {
  const planRunId = `plan-${sessionId}`;
  const facts = [
    fact(sessionId, planRunId, 1, 'execution.plan.bound', {
      parentGoalText: '制作1个铁镐',
      goalSignature: 'obtain:item:minecraft:iron_pickaxe:1',
      experienceMode: 'experiment',
      experimentSplit: 'selection',
      candidateId: 'candidate:制作1个铁镐',
      planGraph: {
        id: planRunId,
        goalId: `goal-${sessionId}`,
        nodes: [{ id: 'node-1', goal: { id: 'g1', goalText: '制作1个铁镐', metadata: { targetId: 'minecraft:iron_pickaxe' } }, state: 'ready' }],
        edges: [], budget: { maxNodes: 8, maxGraphReplans: 2 }, provenance: [],
      },
    }),
    ...body.map(value => ({ ...value, sessionId, runId: planRunId, planRunId, correlationId: `corr-${sessionId}` })),
    fact(sessionId, planRunId, 50, 'execution.session.terminal', outcome === 'succeeded'
      ? { outcome, handoff: 'none', verdict: { ok: true, detail: 'done' } }
      : {
          outcome, handoff: 'graph_replan_required', verdict: { ok: false, detail: 'resource budget insufficient' },
          failure: {
            code: 'planner.resource_budget_insufficient', origin: 'decision', stage: 'deciding', category: 'precondition',
            retryable: false, ownerActionable: false, evidenceRefs: [`${sessionId}:failure`],
          },
        }),
  ];
  return {
    sessionId, runId: planRunId, planRunId, planRevision: 1, nodeId: 'node-1', state: 'finalized',
    firstSequence: 1, lastContiguousSequence: 50, maxSequence: 50, terminalSequence: 50, outcome, facts,
  };
}

function progress(sequence: number, inventoryDelta: Record<string, number>): ExecutionFactEnvelopeV1 {
  return fact('placeholder', 'placeholder', sequence, 'execution.progress.observed', { inventoryDelta, meaningful: true });
}
function proposed(sequence: number, proposal: Record<string, unknown>): ExecutionFactEnvelopeV1 {
  return fact('placeholder', 'placeholder', sequence, 'execution.action.proposed', { proposal });
}
function fact(
  sessionId: string,
  planRunId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
): ExecutionFactEnvelopeV1 {
  return {
    schema: EXECUTION_FACT_SCHEMA_V1,
    eventId: `${sessionId}:event:${sequence}`,
    eventType,
    sessionId,
    runId: planRunId,
    planRunId,
    planRevision: 1,
    nodeId: 'node-1',
    sequence,
    occurredAt: new Date(Date.UTC(2026, 7, 4, 0, 0, sequence)).toISOString(),
    codeRevision: 'test', configRevision: 'test', correlationId: `corr-${sessionId}`, payload,
  };
}
