import type { PlanNode } from '../../planner/plannerContracts.js';
import type { TaskRuntime, TaskState } from '../../taskRuntime.js';
import type { GoalAgentStateV1 } from '../goalAgentState.js';

/** Read-only projection of GoalAgent checkpoints into the existing task tree. */
export class GoalAgentTaskProjection {
  private readonly roots = new Map<string, string>();
  private readonly nodes = new Map<string, string>();

  constructor(private readonly tasks: TaskRuntime) {}

  update(state: Readonly<GoalAgentStateV1>): void {
    const rootId = this.rootTaskId(state.sessionId) ?? this.createRoot(state);
    const graph = state.plan.graph;
    if (graph) {
      for (const node of graph.nodes) this.projectNode(state, node, rootId);
    }
    this.settleSupersededMirrors(state, rootId);
    this.settleHistoricalMirrors(state, rootId);
    const root = this.tasks.list().find(task => task.id === rootId);
    if (!root) return;
    if (state.phase === 'paused_owner') {
      if (root.state === 'running') this.tasks.pause(rootId, {
        goalAgentSessionId: state.sessionId,
        question: state.owner.question ?? 'owner input required',
      });
      return;
    }
    if (state.phase === 'completed') {
      if (root.state !== 'completed') this.tasks.complete(rootId);
      return;
    }
    if (state.phase === 'failed') {
      if (root.state !== 'failed') this.tasks.fail(rootId, {
        code: 'unknown',
        detail: state.terminal?.summary ?? state.verdict?.summary ?? 'GoalAgent failed',
      });
      return;
    }
    if (state.phase === 'timed_out') {
      if (root.state !== 'failed') this.tasks.fail(rootId, {
        code: 'unknown',
        detail: state.terminal?.summary ?? 'GoalAgent timed out',
      });
      return;
    }
    if (state.phase === 'cancelled') {
      if (root.state !== 'cancelled') this.tasks.cancel(rootId, state.terminal?.summary ?? 'GoalAgent cancelled');
      return;
    }
    if (root.state === 'paused') this.tasks.resume(rootId);
  }

  rootTaskId(sessionId: string): string | null {
    const known = this.roots.get(sessionId);
    if (known) return known;
    const restored = this.tasks.list().find(task => task.kind === 'goal_exec'
      && task.params.goalAgentSessionId === sessionId);
    if (!restored) return null;
    this.roots.set(sessionId, restored.id);
    return restored.id;
  }

  private createRoot(state: Readonly<GoalAgentStateV1>): string {
    const task = this.tasks.createTask('goal_exec', {
      goalText: state.request.requestText,
      goalAgentSessionId: state.sessionId,
      interactionSessionId: state.interactionSessionId,
    }, {
      label: `目标：${state.request.requestText}`,
      priority: 45,
      feedbackPolicy: 'internal',
    });
    const started = this.tasks.startEmergency(task.id);
    if (!started.ok) throw new Error(`GoalAgent task projection failed: ${started.reason ?? 'start failed'}`);
    this.roots.set(state.sessionId, task.id);
    return task.id;
  }

  private projectNode(state: Readonly<GoalAgentStateV1>, node: PlanNode, rootId: string): void {
    const key = `${state.sessionId}:r${state.plan.revision}:${node.id}`;
    let mirrorId = this.nodes.get(key);
    if (!mirrorId) {
      mirrorId = this.tasks.mirrorPlanNode(
        node.goal.taskFamily || 'goal_task',
        {
          goalText: node.goal.goalText,
          goalAgentSessionId: state.sessionId,
          planRevision: state.plan.revision,
          planNodeId: node.id,
          successCriteria: node.goal.metadata?.structuredSuccessCriteria ?? node.goal.successCriteria,
        },
        rootId,
        node.goal.goalText,
        taskState(node, state.plan.activeNodeId, state.phase),
      );
      this.nodes.set(key, mirrorId);
    } else {
      const current = this.tasks.getById(mirrorId)?.state;
      if (current && isTerminalTaskState(current)) return;
      this.tasks.mirrorSetState(
        mirrorId,
        taskState(node, state.plan.activeNodeId, state.phase),
        state.terminal?.summary,
      );
    }
  }

  private settleHistoricalMirrors(state: Readonly<GoalAgentStateV1>, rootId: string): void {
    if (state.phase !== 'completed' && state.phase !== 'failed' && state.phase !== 'cancelled') return;
    const detail = state.terminal?.summary ?? `GoalAgent ${state.phase}`;
    for (const task of this.tasks.list()) {
      if (task.parentId !== rootId || !task.id.startsWith('mirror-')) continue;
      if (task.params.goalAgentSessionId !== state.sessionId || isTerminalTaskState(task.state)) continue;
      this.tasks.mirrorSetState(task.id, 'cancelled', detail);
    }
  }

  private settleSupersededMirrors(state: Readonly<GoalAgentStateV1>, rootId: string): void {
    if (state.plan.revision < 2) return;
    for (const task of this.tasks.list()) {
      if (task.parentId !== rootId || !task.id.startsWith('mirror-')) continue;
      if (task.params.goalAgentSessionId !== state.sessionId || isTerminalTaskState(task.state)) continue;
      const taskRevision = Number(task.params.planRevision);
      if (Number.isFinite(taskRevision) && taskRevision < state.plan.revision) {
        this.tasks.mirrorSetState(
          task.id,
          'cancelled',
          `superseded by plan revision ${state.plan.revision}`,
        );
      }
    }
  }
}

function taskState(
  node: PlanNode,
  activeNodeId: string | null,
  phase: GoalAgentStateV1['phase'],
): TaskState {
  if (node.state === 'satisfied') return 'completed';
  if (node.state === 'failed') return 'failed';
  if (node.state === 'skipped') return 'cancelled';
  if (phase === 'cancelled') return 'cancelled';
  if (phase === 'failed') return node.id === activeNodeId || node.state === 'dispatched' ? 'failed' : 'cancelled';
  if (phase === 'completed') return 'cancelled';
  if (node.state === 'needs_replan') return 'paused';
  if (node.id === activeNodeId || node.state === 'dispatched') return 'running';
  return 'pending';
}

function isTerminalTaskState(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
