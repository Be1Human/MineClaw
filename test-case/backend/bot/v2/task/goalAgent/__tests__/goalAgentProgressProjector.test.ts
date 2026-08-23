import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { projectGoalAgentProgressReport } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentProgressProjector.js';
import type { GoalAgentLoopEvent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentEvents.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: 'interaction-1', messageId: 'request-1', correlationId: 'corr-1',
      conversationId: 'conversation-1', sequence: 1, emittedAt: '2026-08-23T00:00:00.000Z',
      idempotencyKey: 'request-1',
    },
    origin: 'player_message', originalText: '做一个工作台', requestText: '做一个工作台',
    requestKind: 'task', constraints: [],
  };
}

function state() {
  const value = createGoalAgentState({ sessionId: 'goal-1', interactionSessionId: 'interaction-1', request: request() });
  value.revision = 7;
  value.updatedAt = '2026-08-23T00:00:07.000Z';
  value.plan = {
    revision: 2, activeNodeId: 'get-planks', history: [],
    graph: {
      id: 'plan-2', goalId: 'goal-root', provenance: [], edges: [], budget: { maxNodes: 4, maxGraphReplans: 2 },
      nodes: [
        { id: 'get-log', state: 'satisfied', goal: { goalText: '取得原木' }, preconditions: [], postconditions: [], planRecoveryRefs: [], estimatedCost: { actions: 1, durationMs: 1, llmRounds: 1, risk: 0 }, provenance: [] },
        { id: 'get-planks', state: 'ready', goal: { goalText: '制作木板' }, preconditions: [], postconditions: [], planRecoveryRefs: [], estimatedCost: { actions: 1, durationMs: 1, llmRounds: 1, risk: 0 }, provenance: [] },
      ],
    } as typeof value.plan.graph,
  };
  return value;
}

function event(
  tools: Array<{ name: string; ok?: boolean }>,
  type = 'goalagent.round.completed',
): GoalAgentLoopEvent {
  return {
    type, sessionId: 'goal-1', revision: 7, epoch: 1, phase: 'running', node: 'round',
    payload: { tools, summary: 'round completed', evidenceRefs: ['failure:no_resource'] },
  };
}

describe('FEAT-CROSS-18 · GoalAgent progress projector', () => {
  it('把动作失败和重新提交计划投影为带证据的 running GoalReportV2', () => {
    const current = state();
    current.action.result = {
      executionSessionId: 'exec-1', idempotencyKey: 'action-1', ok: false,
      detail: 'no resource', startedAt: current.updatedAt, completedAt: current.updatedAt,
      evidenceRefs: ['failure:no_resource'],
    };
    const obstacle = projectGoalAgentProgressReport(current, event([{ name: 'action_execute', ok: false }]));
    assert.equal(obstacle?.status, 'running');
    assert.equal(obstacle?.update?.kind, 'obstacle');
    assert.deepEqual(obstacle?.progress, { current: 1, total: 2, milestone: 'recovering' });
    assert.deepEqual(obstacle?.evidence.map(item => item.ref), ['failure:no_resource']);

    const decision = projectGoalAgentProgressReport(current, event([{ name: 'plan_commit', ok: true }]));
    assert.equal(decision?.update?.kind, 'decision');
    assert.equal(decision?.progress?.milestone, 'planning');
  });

  it('只在语义转换上报告，普通 observation/model 事件保持在轨迹内部', () => {
    const current = state();
    assert.equal(projectGoalAgentProgressReport(current, event([{ name: 'world_observe', ok: true }])), null);
    assert.equal(projectGoalAgentProgressReport(current, event([{ name: 'action_execute' }], 'goalagent.monitor.sampled')), null);
  });

  it('计划通过和机器验真的下一里程碑只投影 milestone，不伪造完成', () => {
    const current = state();
    current.plan.revision = 1;
    const initialPlan = projectGoalAgentProgressReport(current, event([{ name: 'plan_commit', ok: true }]));
    assert.equal(initialPlan?.update?.kind, 'milestone');
    assert.equal(initialPlan?.update?.nextAction, '制作木板');
    assert.equal(initialPlan?.status, 'running');

    current.verdict = {
      decision: 'continue', summary: '原木里程碑已满足', machineCriteriaSatisfied: false,
      ownerActionable: false, retryable: true, evidenceRefs: ['inventory:oak_log:1'],
    };
    const advanced = projectGoalAgentProgressReport(current, event([{ name: 'action_execute', ok: true }]));
    assert.equal(advanced?.update?.kind, 'milestone');
  });
});
