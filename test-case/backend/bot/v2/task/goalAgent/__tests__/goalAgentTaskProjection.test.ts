import assert from 'node:assert/strict';
import test from 'node:test';

import type { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { MemoryV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import type { PlanNode } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/plannerContracts.js';
import { TaskRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { createGoalAgentState, type GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { GoalAgentTaskProjection } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentTaskProjection.js';

const bus = {
  publish: () => ({ id: '', type: '', level: 'info' as const, timestamp: 0, payload: undefined }),
  on: () => () => {}, onLevel: () => () => {}, onAny: () => () => {}, drain: () => [],
} as unknown as EventBusV2;

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: 'interaction-projection', messageId: 'request-projection',
      correlationId: 'correlation-projection', conversationId: 'conversation-projection', sequence: 1,
      emittedAt: '2026-08-22T00:00:00.000Z', idempotencyKey: 'request-projection',
    },
    origin: 'player_message', originalText: '给我八支火把', requestText: '给我八支火把',
    requestKind: 'task', constraints: [],
  };
}

function planNode(id: string, state: PlanNode['state']): PlanNode {
  return {
    id, state, preconditions: [], postconditions: ['delivered'], planRecoveryRefs: [], provenance: ['test'],
    estimatedCost: { actions: 1, durationMs: 1_000, llmRounds: 1, risk: 0 },
    goal: {
      id: `goal:${id}`, goalText: `轨迹 ${id}`, taskFamily: 'delivery', successCriteria: ['delivered'],
      metadata: { structuredSuccessCriteria: [{ type: 'item_delivered', item: 'torch', count: 8, since: 1 }] },
    },
  };
}

function state(nodes: PlanNode[], activeNodeId: string | null): GoalAgentStateV1 {
  const value = createGoalAgentState({
    sessionId: 'goal-projection', interactionSessionId: 'interaction-projection', request: request(),
  });
  value.phase = 'acting';
  value.activeNode = 'actor';
  value.plan = {
    revision: 1, activeNodeId, history: [],
    graph: {
      id: 'plan-projection', goalId: 'goal-root', nodes, edges: [],
      budget: { maxNodes: 8, maxGraphReplans: 2 }, provenance: ['test'],
    },
  };
  return value;
}

function harness() {
  const memory = new MemoryV2(':memory:');
  const tasks = new TaskRuntime(memory, bus);
  return { memory, tasks, projection: new GoalAgentTaskProjection(tasks) };
}

test('BUG-CROSS-58 · failed root immediately fails active trajectory with no running residue', () => {
  const { memory, tasks, projection } = harness();
  try {
    const value = state([planNode('deliver', 'dispatched')], 'deliver');
    projection.update(value);
    assert.equal(tasks.list().filter(task => task.parentId).at(0)?.state, 'running');

    value.phase = 'failed';
    value.activeNode = 'terminal';
    value.terminal = {
      outcome: 'failed', summary: 'machine verification failed',
      completedAt: '2026-08-22T00:00:01.000Z', evidenceRefs: [],
    };
    projection.update(value);

    const snapshots = tasks.list();
    assert.equal(snapshots.find(task => !task.parentId)?.state, 'failed');
    assert.equal(snapshots.find(task => task.parentId)?.state, 'failed');
    assert.equal(snapshots.filter(task => task.state === 'running' || task.state === 'paused').length, 0);
  } finally { memory.close(); }
});

test('BUG-CROSS-58 · cancelled root cancels unfinished trajectories and preserves completed ones', () => {
  const { memory, tasks, projection } = harness();
  try {
    const value = state([planNode('prepared', 'satisfied'), planNode('deliver', 'dispatched')], 'deliver');
    projection.update(value);

    value.phase = 'cancelled';
    value.activeNode = 'terminal';
    value.terminal = {
      outcome: 'cancelled', summary: 'owner cancelled',
      completedAt: '2026-08-22T00:00:01.000Z', evidenceRefs: [],
    };
    projection.update(value);

    const children = tasks.list().filter(task => task.parentId).sort((a, b) => a.label!.localeCompare(b.label!));
    assert.deepEqual(children.map(task => [task.label, task.state]), [
      ['轨迹 deliver', 'cancelled'],
      ['轨迹 prepared', 'completed'],
    ]);
    assert.equal(tasks.list().filter(task => task.state === 'running' || task.state === 'paused').length, 0);
  } finally { memory.close(); }
});

test('BUG-CROSS-58 · terminal trajectory state never regresses on a later projection update', () => {
  const { memory, tasks, projection } = harness();
  try {
    const value = state([planNode('prepared', 'satisfied')], null);
    projection.update(value);
    value.plan.graph!.nodes[0]!.state = 'ready';
    value.plan.activeNodeId = 'prepared';
    projection.update(value);
    assert.equal(tasks.list().find(task => task.parentId)?.state, 'completed');
  } finally { memory.close(); }
});

test('BUG-CROSS-58 · completed root settles mirrors from every historical plan revision', () => {
  const { memory, tasks, projection } = harness();
  try {
    const value = state([planNode('deliver', 'dispatched')], 'deliver');
    projection.update(value);

    value.plan.revision = 2;
    value.plan.graph = {
      ...value.plan.graph!,
      id: 'plan-projection-r2',
      nodes: [planNode('deliver', 'satisfied')],
    };
    value.plan.activeNodeId = null;
    value.phase = 'completed';
    value.activeNode = 'terminal';
    value.terminal = {
      outcome: 'completed', summary: 'verified after replan',
      completedAt: '2026-08-22T00:00:02.000Z', evidenceRefs: [],
    };
    projection.update(value);

    const children = tasks.list().filter(task => task.parentId)
      .sort((a, b) => Number(a.params.planRevision) - Number(b.params.planRevision));
    assert.deepEqual(children.map(task => [task.params.planRevision, task.state]), [
      [1, 'cancelled'],
      [2, 'completed'],
    ]);
    assert.equal(tasks.list().filter(task => task.state === 'running' || task.state === 'paused').length, 0);
  } finally { memory.close(); }
});

test('BUG-CROSS-74 · a live new revision cancels superseded non-terminal mirrors immediately', () => {
  const { memory, tasks, projection } = harness();
  try {
    const value = state([planNode('obtain-table', 'dispatched')], 'obtain-table');
    projection.update(value);

    value.plan.revision = 2;
    value.plan.graph = {
      ...value.plan.graph!,
      id: 'plan-projection-r2',
      nodes: [planNode('gather-log', 'ready')],
    };
    value.plan.activeNodeId = 'gather-log';
    projection.update(value);

    const root = tasks.list().find(task => !task.parentId)!;
    const children = tasks.list().filter(task => task.parentId === root.id)
      .sort((left, right) => Number(left.params.planRevision) - Number(right.params.planRevision));
    assert.deepEqual(children.map(task => [task.params.planRevision, task.state]), [
      [1, 'cancelled'],
      [2, 'running'],
    ]);
    assert.equal(root.state, 'running');
  } finally { memory.close(); }
});
