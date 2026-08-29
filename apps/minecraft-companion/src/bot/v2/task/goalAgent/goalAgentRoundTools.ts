import { createHash, randomUUID } from 'node:crypto';
import type { LLMToolSchema } from '../../cognitive/llm/types.js';
import type { GoalCapabilityKnowledgePort } from '../../decision/goalAgentPort/goalCapabilityRouter.js';
import type {
  GoalKnowledgePort,
  GoalTargetCandidate,
  GoalTargetDefinition,
} from '../../knowledge/goalTargetKnowledge.js';
import type { GoalAgentDomainKnowledgePort } from '../../knowledge/domainKnowledge.js';
import type { GoalAgentSkillKnowledgePort } from '../../skills/goalAgentSkillKnowledge.js';
import { GOAL_CONTRACT_SCHEMA_V1, type GoalContractV1 } from '../contracts/goalContract.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import { ContextEncoder } from '../planner/contextEncoder.js';
import type { ColdStartPlannerPort } from '../planner/planGraphBuilder.js';
import { GoalSignatureCompiler } from '../planner/goals/goalSignatureCompiler.js';
import { PlanVerifier } from '../planner/planVerifier.js';
import type {
  AgentGoalOutcome,
  CommittedAgentGoal,
  GoalContract,
  ParentGoalTargetKind,
  PlanGraph,
  PlanNode,
} from '../planner/plannerContracts.js';
import {
  requiredMilestoneCoverageIssues,
  requiredPlanMilestones,
} from './goalAgentPlanMilestones.js';
import {
  freezeCurrentPlanRevision,
  planRevisionReason,
  satisfyAndUnlockPlanNode,
} from './goalAgentPlanState.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalAgentTools } from './goalAgentRuntimeContracts.js';
import { stableJson } from './goalAgentJson.js';

export interface GoalAgentRoundToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface GoalAgentRoundToolReceipt {
  content: Record<string, unknown>;
  summary: string;
  evidenceRefs: string[];
}

export interface GoalAgentRoundToolRuntimeOptions {
  profileId: string;
  tools: GoalAgentTools;
  skills?: GoalAgentSkillKnowledgePort;
  domainKnowledge?: GoalAgentDomainKnowledgePort;
  capabilities?: GoalCapabilityKnowledgePort;
  planMilestones?: ColdStartPlannerPort;
  now?: () => string;
  goalId?: () => string;
}

type ToolHandler = (
  state: GoalAgentStateV1,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<GoalAgentRoundToolReceipt>;

interface RegisteredTool {
  schema: LLMToolSchema;
  execute: ToolHandler;
}

const OUTCOMES = new Set<AgentGoalOutcome>([
  'obtain', 'deliver', 'deposit', 'place', 'reach', 'build', 'defeat', 'explore', 'survive',
]);
const KINDS = new Set<ParentGoalTargetKind>(['item', 'entity', 'location', 'structure', 'state']);
const SUPPORTED_CRITERION_TYPES = new Set([
  'entity_dead', 'inventory', 'inventory_decrease', 'item_delivered', 'item_deposited',
  'block_placed', 'reached', 'predicate',
]);

/** One registry is used for prompt exposure, lookup and execution. */
export class GoalAgentRoundToolRuntime {
  private readonly registry = new Map<string, RegisteredTool>();
  private readonly encoder = new ContextEncoder();
  private readonly signatures = new GoalSignatureCompiler();
  private readonly verifier = new PlanVerifier();
  private readonly now: () => string;
  private readonly goalId: () => string;
  /** BUG-CROSS-80 · 每个会话连续空搜索（knowledge/skill/capability）次数，供反馈协议读取。 */
  private readonly emptySearchStreaks = new Map<string, number>();

  constructor(private readonly options: GoalAgentRoundToolRuntimeOptions) {
    if (!options.profileId.trim()) throw new Error('GoalAgent round tools require profileId');
    this.now = options.now ?? (() => new Date().toISOString());
    this.goalId = options.goalId ?? (() => `goal-${randomUUID()}`);
    for (const tool of this.buildRegistry()) {
      const name = tool.schema.function.name;
      if (this.registry.has(name)) throw new Error(`duplicate GoalAgent round tool: ${name}`);
      this.registry.set(name, tool);
    }
  }

  schemas(): LLMToolSchema[] {
    return [...this.registry.values()]
      .map(tool => structuredClone(tool.schema))
      .sort((left, right) => left.function.name.localeCompare(right.function.name));
  }

  names(): string[] {
    return [...this.registry.keys()].sort((left, right) => left.localeCompare(right));
  }

  /** BUG-CROSS-80 · 当前会话连续空搜索结果次数（反馈协议判定用）。 */
  emptySearchStreak(sessionId: string): number {
    return this.emptySearchStreaks.get(sessionId) ?? 0;
  }

  private noteSearchResult(sessionId: string, empty: boolean): void {
    if (empty) {
      this.emptySearchStreaks.set(sessionId, this.emptySearchStreak(sessionId) + 1);
    } else {
      this.emptySearchStreaks.delete(sessionId);
    }
  }

  async execute(
    call: GoalAgentRoundToolCall,
    state: GoalAgentStateV1,
    signal: AbortSignal,
  ): Promise<GoalAgentRoundToolReceipt> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return failureReceipt(`unknown_tool:${call.name}`);
    }
    if (signal.aborted) throw abortError();
    try {
      return await tool.execute(state, structuredClone(call.arguments), signal);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      return failureReceipt(`tool_failed:${call.name}:${detail}`);
    }
  }

  private buildRegistry(): RegisteredTool[] {
    return [
      this.tool('goal_search_targets', 'Search the controlled goal target catalog by player-language noun.', {
        query: { type: 'string' },
        kind: { type: 'string', enum: [...KINDS] },
      }, ['query'], (state, args) => this.searchTargets(state, args)),
      this.tool('goal_get_target', 'Read one controlled target definition by registryId.', {
        registryId: { type: 'string' },
      }, ['registryId'], (state, args) => this.getTarget(state, args)),
      this.tool('goal_create', 'Create the durable root goal after selecting a controlled target. outcome must faithfully reflect the player intent: "给我/交给/递给/拿给/扔给/交给玩家 X" or "give/deliver/bring X to me" requires outcome=deliver; only "做/造/采/获得 X" without handover wording may use outcome=obtain. A deliver goal is only complete after the item is really handed to the owner, never when it merely sits in your inventory.', {
        outcome: { type: 'string', enum: [...OUTCOMES] },
        target: {
          type: 'object',
          properties: {
              kind: { type: 'string', enum: [...KINDS], description: 'Optional hint; canonical kind is bound from the selected registryId.' },
              surface: { type: 'string', description: 'Optional display text; defaults to the selected registryId.' },
              registryId: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['registryId', 'quantity'],
        },
        placement: {
          type: 'object',
          properties: {
            relativeTo: { type: 'string', enum: ['owner', 'self'] },
            relation: { type: 'string', enum: ['near', 'right', 'front', 'at', 'underfoot'] },
            radius: { type: 'number', minimum: 0.1 },
          },
          required: ['relativeTo', 'relation'],
        },
        constraints: { type: 'array', items: { type: 'string' } },
      }, ['outcome', 'target'], (state, args) => this.createGoal(state, args)),
      this.tool('world_observe', 'Read a fresh bounded world snapshot. Use before planning, answering queries and after environmental change.', {}, [],
        (state, _args, signal) => this.observeWorld(state, signal)),
      this.tool('experience_load', 'Load relevant prior execution experience. Requires both goal_create and world_observe to have succeeded first.', {}, [],
        state => this.loadExperience(state)),
      this.tool('plan_read', 'Read the current plan, machine-required milestones and active task.', {}, [],
        state => this.readPlan(state)),
      this.tool('plan_commit', 'Create or replace the current machine-verifiable task plan. Copy authoritative criteria exactly from goal_create.successCriteria and plan_read.requiredMilestones; preserve dynamic fields such as since and never invent criterion type aliases. Inventory checkpoints must be separate predecessor tasks from actions that consume the same item (place/deliver/deposit/decrease).', {
        rationale: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              goalText: { type: 'string' },
              successCriteria: {
                type: 'array',
                description: 'Exact machine criteria copied from goal_create or plan_read. Supported type values are enumerated below.',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: [...SUPPORTED_CRITERION_TYPES] },
                    entityId: { type: 'string' },
                    entityName: { type: 'string' },
                    item: { type: 'string' },
                    count: { type: 'number', minimum: 0 },
                    from: { type: 'number', minimum: 0 },
                    since: { type: 'number', minimum: 0 },
                    position: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                      required: ['x', 'y', 'z'],
                    },
                    radius: { type: 'number', minimum: 0 },
                    relativeTo: { type: 'string', enum: ['owner', 'self'] },
                    relation: {
                      type: 'string',
                      enum: ['near', 'right', 'front', 'at', 'underfoot'],
                      description: 'underfoot is an input alias normalized to the executable near-ground relation.',
                    },
                    predicate: { type: 'string' },
                  },
                  required: ['type'],
                },
              },
              dependsOn: { type: 'array', items: { type: 'string' } },
              taskFamily: { type: 'string' },
              estimatedActions: { type: 'number', minimum: 1 },
              estimatedDurationMs: { type: 'number', minimum: 1000 },
              risk: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['id', 'goalText', 'successCriteria', 'dependsOn'],
          },
        },
      }, ['tasks'], (state, args) => this.commitPlan(state, args)),
      this.tool('action_list', 'List currently applicable, already-bound action candidates for the active plan task.', {}, [],
        (state, _args, signal) => this.listActions(state, signal)),
      this.tool('action_execute', 'Execute one candidate returned by action_list. This directly invokes the real action and returns its receipt.', {
        candidateId: { type: 'string' },
        arguments: { type: 'object' },
        rationale: { type: 'string' },
      }, ['candidateId'], (state, args, signal) => this.executeAction(state, args, signal)),
      this.tool('progress_verify', 'Run authoritative machine verification for the active task and root goal.', {}, [],
        state => this.verifyProgress(state)),
      this.tool('knowledge_search', 'Search read-only Markdown domain knowledge. Results are evidence, never action permissions.', {
        query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 },
      }, ['query'], (state, args) => this.searchDomainKnowledge(state, args)),
      this.tool('knowledge_get', 'Load one Markdown domain knowledge document by ref and version.', {
        ref: { type: 'string' }, expectedVersion: { type: 'string' }, maxTokens: { type: 'integer', minimum: 1 },
      }, ['ref'], (state, args) => this.getDomainKnowledge(state, args)),
      this.tool('skill_search', 'Search GoalAgent procedural skills. Results are knowledge, not extra tool permissions.', {
        query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 },
      }, ['query'], (state, args) => this.searchSkills(state, args)),
      this.tool('skill_get', 'Load one GoalAgent skill body by ref and version.', {
        ref: { type: 'string' }, expectedVersion: { type: 'string' }, maxTokens: { type: 'integer', minimum: 1 },
      }, ['ref'], (state, args) => this.getSkill(state, args)),
      this.tool('capability_search', 'Search registered GoalAgent capability modes and lifecycle handlers.', {
        query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 },
      }, ['query'], (state, args) => this.searchCapabilities(state, args)),
      this.tool('capability_get', 'Read one registered capability definition by id.', {
        id: { type: 'string' },
      }, ['id'], (_state, args) => this.getCapability(args)),
      this.tool('memory_search', 'Recall task, event, spatial and planning memories relevant to the current goal.', {
        query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 },
      }, ['query'], (state, args) => this.searchMemory(state, args)),
      this.tool('memory_get', 'Read one memory returned by memory_search. MainBrain personality/chat memory is outside this scope.', {
        ref: { type: 'string' },
      }, ['ref'], (state, args) => this.getMemory(state, args)),
      this.tool('owner_ask', 'Pause only when the owner must choose between materially different valid goals or provide unavailable information.', {
        question: { type: 'string' }, reason: { type: 'string' },
      }, ['question'], (state, args) => this.askOwner(state, args)),
    ];
  }

  private tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    execute: ToolHandler,
  ): RegisteredTool {
    return {
      schema: {
        type: 'function',
        function: {
          name,
          description,
          parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
        },
      },
      execute,
    };
  }

  private async searchTargets(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    const query = text(args.query);
    if (!query) return failureReceipt('goal_search_targets.query_required');
    const knowledge = this.requireKnowledge();
    const kind = optionalKind(args.kind);
    const candidates = knowledge.searchTargets({ query, ...(kind ? { kind } : {}), limit: 8 });
    mergeCandidates(state, candidates);
    return {
      content: { ok: true, candidates },
      summary: `found ${candidates.length} goal targets`,
      evidenceRefs: candidates.map(candidate => candidate.evidenceRef),
    };
  }

  private async getTarget(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    const registryId = text(args.registryId);
    const target = registryId ? this.requireKnowledge().getTarget(registryId) : null;
    if (!target) return failureReceipt(`goal_target_not_found:${registryId || '(empty)'}`);
    const candidate = asCandidate(target);
    mergeCandidates(state, [candidate]);
    return { content: { ok: true, target: candidate }, summary: `loaded ${candidate.registryId}`, evidenceRefs: [candidate.evidenceRef] };
  }

  private async createGoal(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (state.rootGoal) {
      return { content: { ok: true, alreadyCreated: true, goal: state.rootGoal }, summary: 'root goal already exists', evidenceRefs: state.interpretation.evidenceRefs };
    }
    const proposedTarget = record(args.target);
    const registryId = text(proposedTarget.registryId);
    const selected = state.interpretation.candidates.find(candidate => candidate.registryId === registryId);
    const canonical = selected ? this.requireKnowledge().getTarget(selected.registryId) : null;
    if (!selected || !canonical) return failureReceipt('goal target must come from goal_search_targets or goal_get_target');
    // BUG-CROSS-80 · 交付语义 fail closed：玩家请求含"给我/交给/递给…"而模型选了非 deliver → 结构化拒绝，
    // 防止"背包里有"冒充"已交付"（真服实证：石斧在背包即 completed，主人未收到）。
    const outcome = text(args.outcome);
    const deliveryHint = /(?:给我|交给|递给|送给|拿给|扔给|deliver|give|bring)/i.test(state.request.requestText ?? '');
    if (deliveryHint && outcome !== 'deliver') {
      return failureReceipt(
        `goal_create_outcome_mismatch: 玩家请求含交付语义（给我/交给/递给…），outcome 必须为 deliver（判据 item_delivered，需真实交付收据）`,
      );
    }
    const normalizedArgs = {
      ...args,
      target: {
        ...proposedTarget,
        kind: canonical.kind,
        surface: text(proposedTarget.surface) || selected.matchedAlias || canonical.registryId,
        registryId: canonical.registryId,
      },
    };
    const built = buildCommittedGoal(state, normalizedArgs);
    if ('error' in built) return failureReceipt(built.error);
    const committed = commitGoal({
      input: built.goal,
      target: canonical,
      args: normalizedArgs,
      profileId: this.options.profileId,
      goalId: this.goalId(),
      acceptedAt: this.now(),
      signatures: this.signatures,
    });
    if ('error' in committed) return failureReceipt(committed.error);
    state.rootGoal = committed.rootGoal;
    state.goal = {
      definition: committed.goal,
      signature: committed.signature,
      // goal_create refines goal semantics; it must not erase an observation
      // already committed earlier in the same continuous tool loop.
      context: state.goal.context,
    };
    state.interpretation.lastValidationError = null;
    state.interpretation.clarificationReason = null;
    return {
      content: {
        ok: true,
        goalId: committed.rootGoal.goalId,
        goalSignature: committed.signature.key,
        successCriteria: committed.goal.successCriteria,
      },
      summary: `created root goal ${committed.signature.key}`,
      evidenceRefs: [...state.interpretation.evidenceRefs],
    };
  }

  private async observeWorld(
    state: GoalAgentStateV1,
    signal: AbortSignal,
    verifyRoot = true,
  ): Promise<GoalAgentRoundToolReceipt> {
    const perception = this.options.tools.perception;
    if (!perception) return failureReceipt('world_perception_unavailable');
    const world = await perception.observe(signal);
    const observedAt = new Date(world.timestamp).toISOString();
    state.world = {
      latest: structuredClone(world),
      beforeAction: state.world.latest ? structuredClone(state.world.latest) : state.world.beforeAction,
      observedAt,
    };
    state.goal.context = this.encoder.encode({
      inventory: world.inventory.items,
      timeOfDay: world.environment.timeOfDay,
      dangerLevel: Math.min(1, world.entities.filter(entity => entity.category === 'hostile' && entity.distance <= 16).length / 4),
      position: world.self.position,
      worldRevision: `tick:${world.tick}`,
    });
    const evidenceRef = `world:${world.tick}:${world.timestamp}`;
    if (verifyRoot && state.rootGoal && this.options.tools.verification) {
      const root = await this.options.tools.verification.verifyRoot({ state });
      if (root.ok) completeState(state, root.detail, root.evidenceRefs, this.now());
    }
    return {
      content: { ok: true, world: boundedWorld(world), rootCompleted: state.terminal?.outcome === 'completed' },
      summary: `observed world tick ${world.tick}`,
      evidenceRefs: [evidenceRef, ...(state.terminal?.evidenceRefs ?? [])],
    };
  }

  private async loadExperience(state: GoalAgentStateV1): Promise<GoalAgentRoundToolReceipt> {
    if (state.experience.frozenAt) {
      return { content: { ok: true, refs: state.experience.refs, alreadyLoaded: true }, summary: 'experience already loaded', evidenceRefs: [...state.experience.refs] };
    }
    const port = this.options.tools.experience;
    if (!port || !state.rootGoal || !state.goal.signature || !state.goal.context) {
      return failureReceipt('experience_requires_goal_world_and_port');
    }
    const frozen = await port.freeze({
      planRunId: state.sessionId,
      goalText: state.rootGoal.goalText,
      goalSignature: state.goal.signature,
      context: state.goal.context,
    });
    const bundle = frozen.status === 'frozen' ? frozen.bundle : null;
    const refs = frozen.status === 'frozen'
      ? [...new Set([frozen.bundle.bundleId, frozen.bundle.selectionManifestId, ...frozen.bundle.evidenceRefs])]
      : [frozen.selectionManifest.id];
    state.experience = {
      bundle: bundle ? structuredClone(bundle) : null,
      refs,
      frozenAt: frozen.status === 'frozen' ? frozen.bundle.frozenAt : this.now(),
    };
    return { content: { ok: true, status: frozen.status, refs }, summary: `experience ${frozen.status}`, evidenceRefs: refs };
  }

  private async readPlan(state: GoalAgentStateV1): Promise<GoalAgentRoundToolReceipt> {
    return {
      content: {
        ok: true,
        plan: state.plan.graph,
        activeNodeId: state.plan.activeNodeId,
        requiredMilestones: requiredPlanMilestones(state, this.options.planMilestones),
      },
      summary: state.plan.graph ? `read plan revision ${state.plan.revision}` : 'no plan committed',
      evidenceRefs: [...state.experience.refs],
    };
  }

  private async commitPlan(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!state.rootGoal || !state.goal.signature || !state.goal.context) return failureReceipt('plan_requires_goal_and_world');
    if (state.plan.graph && state.budget.graphReplans >= state.budget.maxGraphReplans) return failureReceipt('graph_replan_budget_exhausted');
    const parsed = parsePlanProposal(args, 24);
    if ('error' in parsed) return failureReceipt(parsed.error);
    const tasks = parsed.tasks.map(task => ({
      ...task,
      successCriteria: task.successCriteria.map(criterion =>
        bindAuthoritativeDynamicCriterionFields(
          normalizeCriterionAliases(criterion),
          state.rootGoal!.successCriteria,
        )),
    }));
    const revision = state.plan.revision + 1;
    const graph = buildPlanGraph(state, tasks, revision, 24);
    const plannedCriteria = graph.nodes.flatMap(node => node.goal.metadata?.structuredSuccessCriteria ?? []);
    const required = requiredPlanMilestones(state, this.options.planMilestones);
    const issues = [
      ...this.verifier.verify(graph).errors,
      ...transientMilestoneIssues(graph),
      ...rootCoverageIssues(plannedCriteria, [...state.rootGoal.successCriteria]),
      ...requiredMilestoneCoverageIssues(plannedCriteria, required),
      ...(graph.nodes.some(node => node.state === 'ready') ? [] : ['plan_has_no_ready_task']),
    ];
    if (issues.length) return failureReceipt(`plan_rejected:${issues.join(';')}`);
    const history = [
      ...freezeCurrentPlanRevision(state),
      { revision, graph: structuredClone(graph), reason: planRevisionReason(state), createdAt: this.now() },
    ];
    if (state.plan.graph) state.budget.graphReplans += 1;
    state.plan = {
      graph,
      revision,
      activeNodeId: graph.nodes.find(node => node.state === 'ready')?.id ?? null,
      history,
    };
    state.action = { proposal: null, result: null, executionSessionId: null, idempotencyKey: null };
    state.verdict = null;
    return {
      content: { ok: true, revision, activeNodeId: state.plan.activeNodeId, taskCount: graph.nodes.length },
      summary: `committed plan revision ${revision}`,
      evidenceRefs: [...state.experience.refs],
    };
  }

  private async listActions(state: GoalAgentStateV1, signal: AbortSignal): Promise<GoalAgentRoundToolReceipt> {
    const execution = this.options.tools.execution;
    const planNodeId = state.plan.activeNodeId;
    if (!execution || !state.rootGoal) return failureReceipt('action_list_requires_execution_and_root_goal');
    const candidates = await execution.listCandidates({ state, ...(planNodeId ? { planNodeId } : {}), signal });
    return {
      content: {
        ok: true,
        target: planNodeId ?? 'root',
        candidates: candidates.map(candidate => ({
          id: candidate.id,
          kind: candidate.kind,
          action: candidate.action,
          description: candidate.description,
          fixedArgs: candidate.fixedArgs,
          argumentSchema: candidate.argumentSchema,
          evidenceRefs: candidate.evidenceRefs,
        })),
      },
      summary: `listed ${candidates.length} actions for ${planNodeId ?? 'root goal'}`,
      evidenceRefs: candidates.flatMap(candidate => candidate.evidenceRefs),
    };
  }

  private async executeAction(
    state: GoalAgentStateV1,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GoalAgentRoundToolReceipt> {
    const execution = this.options.tools.execution;
    const planNodeId = state.plan.activeNodeId;
    if (!execution || !state.rootGoal) return failureReceipt('action_execute_requires_execution_and_root_goal');
    if (state.budget.actions >= state.budget.maxActions) return failureReceipt('action_budget_exhausted');
    const candidateId = text(args.candidateId);
    const candidates = await execution.listCandidates({ state, ...(planNodeId ? { planNodeId } : {}), signal });
    const candidate = candidates.find(value => value.id === candidateId);
    if (!candidate) return failureReceipt(`action_candidate_not_available:${candidateId}`);
    const modelArgs = record(args.arguments);
    const proposal = {
      source: candidate.source,
      action: candidate.action,
      // BUG-CROSS-80 · 模型参数优先：fixedArgs 只兜底未填字段（幂等/审计由 actionKey 保证），
      // 关键业务参数（item/itemName/count）由模型观察世界后填写，schema/领域校验兜底。
      args: { ...structuredClone(candidate.fixedArgs), ...modelArgs },
      rationale: text(args.rationale) || candidate.description,
    };
    const idempotencyKey = actionKey(state, candidate.id, proposal.args);
    state.world.beforeAction = state.world.latest ? structuredClone(state.world.latest) : null;
    state.action = { proposal, result: null, executionSessionId: null, idempotencyKey };
    const result = await execution.execute({
      sessionId: state.sessionId,
      epoch: state.epoch,
      idempotencyKey,
      proposal,
      state,
      signal,
    });
    if (result.idempotencyKey !== idempotencyKey) throw new Error('execution idempotency mismatch');
    state.budget.actions += 1;
    state.action = {
      proposal,
      result: structuredClone(result),
      executionSessionId: result.executionSessionId,
      idempotencyKey,
    };
    if (!result.ok) {
      state.budget.recoveries += 1;
    }
    // Refresh the world first, then verify active leaf + root together below.
    // Letting observeWorld close the root here would skip the leaf checkpoint.
    if (this.options.tools.perception) await this.observeWorld(state, signal, false);
    if (this.options.tools.verification && !state.terminal) {
      if (planNodeId) await this.applyVerification(state, planNodeId);
      else await this.applyRootVerification(state);
    }
    if (!result.ok && !state.terminal && state.budget.recoveries >= state.budget.maxRecoveries) {
      const evidenceRefs = [...new Set(result.evidenceRefs)];
      state.verdict = {
        decision: 'fail',
        summary: `recovery budget exhausted after ${state.budget.recoveries} failed actions: ${result.detail}`,
        machineCriteriaSatisfied: false,
        ownerActionable: result.failure?.ownerActionable === true,
        retryable: false,
        evidenceRefs,
      };
      state.terminal = {
        outcome: 'failed', summary: state.verdict.summary, completedAt: this.now(), evidenceRefs,
      };
      state.phase = 'failed';
      state.activeNode = 'round';
    }
    return {
      content: {
        ok: result.ok,
        result,
        verdict: state.verdict,
        nextPlanNodeId: state.plan.activeNodeId,
        terminal: state.terminal,
      },
      summary: result.ok ? `action completed: ${result.detail}` : `action failed: ${result.detail}`,
      evidenceRefs: [...new Set([...result.evidenceRefs, ...(state.verdict?.evidenceRefs ?? []), ...(state.terminal?.evidenceRefs ?? [])])],
    };
  }

  private async verifyProgress(state: GoalAgentStateV1): Promise<GoalAgentRoundToolReceipt> {
    const planNodeId = state.plan.activeNodeId;
    if (!this.options.tools.verification) return failureReceipt('verification_port_unavailable');
    const verified = planNodeId
      ? await this.applyVerification(state, planNodeId)
      : await this.applyRootVerification(state);
    return {
      content: { ok: true, ...verified, verdict: state.verdict, terminal: state.terminal },
      summary: state.verdict?.summary ?? 'machine verification completed',
      evidenceRefs: [...(state.verdict?.evidenceRefs ?? [])],
    };
  }

  private async applyVerification(state: GoalAgentStateV1, planNodeId: string) {
    const verification = this.options.tools.verification!;
    const [task, root] = await Promise.all([
      verification.verifyTask({ state, planNodeId }),
      verification.verifyRoot({ state }),
    ]);
    const evidenceRefs = [...new Set([...task.evidenceRefs, ...root.evidenceRefs])];
    if (root.ok) {
      // When the same fresh observation proves both the active leaf and the
      // root, persist the leaf checkpoint before closing the session. This
      // keeps the read-only task-history projection truthful instead of
      // displaying the final successful leaf as cancelled.
      if (task.ok && state.plan.graph) {
        const progressed = satisfyAndUnlockPlanNode(state.plan.graph, state.plan, planNodeId);
        state.plan = progressed.plan;
      }
      state.verdict = {
        decision: 'complete', summary: root.detail, machineCriteriaSatisfied: true,
        ownerActionable: false, retryable: false, evidenceRefs,
      };
      completeState(state, root.detail, evidenceRefs, this.now());
    } else if (task.ok && state.plan.graph) {
      const progressed = satisfyAndUnlockPlanNode(state.plan.graph, state.plan, planNodeId);
      state.plan = progressed.plan;
      state.verdict = {
        decision: 'continue', summary: task.detail, machineCriteriaSatisfied: false,
        ownerActionable: false, retryable: true, evidenceRefs,
      };
      state.action = { proposal: null, result: null, executionSessionId: null, idempotencyKey: null };
    } else {
      const failure = state.action.result?.failure;
      state.verdict = {
        decision: failure?.retryable === false ? 'replan' : 'revise_action',
        summary: state.action.result?.detail ?? task.detail,
        machineCriteriaSatisfied: false,
        ownerActionable: failure?.ownerActionable === true,
        retryable: failure?.retryable !== false,
        evidenceRefs,
        ...(failure?.detail ? { hint: failure.detail } : {}),
      };
    }
    return { task, root, evidenceRefs };
  }

  private async applyRootVerification(state: GoalAgentStateV1) {
    const root = await this.options.tools.verification!.verifyRoot({ state });
    if (root.ok) {
      state.verdict = {
        decision: 'complete', summary: root.detail, machineCriteriaSatisfied: true,
        ownerActionable: false, retryable: false, evidenceRefs: [...root.evidenceRefs],
      };
      completeState(state, root.detail, root.evidenceRefs, this.now());
    } else {
      const failure = state.action.result?.failure;
      state.verdict = {
        decision: failure?.retryable === false ? 'replan' : 'revise_action',
        summary: state.action.result?.detail ?? root.detail,
        machineCriteriaSatisfied: false,
        ownerActionable: failure?.ownerActionable === true,
        retryable: failure?.retryable !== false,
        evidenceRefs: [...root.evidenceRefs],
        ...(failure?.detail ? { hint: failure.detail } : {}),
      };
    }
    return { root, evidenceRefs: [...root.evidenceRefs] };
  }

  private async searchSkills(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.skills) return failureReceipt('skill_knowledge_unavailable');
    const results = await this.options.skills.search({
      query: text(args.query),
      objective: 'act',
      ...(state.goal.signature?.key ? { goalSignature: state.goal.signature.key } : {}),
      ...(state.plan.activeNodeId ? { activeStep: state.plan.activeNodeId } : {}),
      ...(state.action.result?.failure?.code ? { failureCode: state.action.result.failure.code } : {}),
      limit: integer(args.limit, 6, 1, 12),
    });
    this.noteSearchResult(state.sessionId, results.length === 0);
    const refs = results.map(result => result.evidenceRef);
    state.cognition.knowledgeRefs = [...new Set([...state.cognition.knowledgeRefs, ...refs])];
    return { content: { ok: true, skills: results }, summary: `found ${results.length} skills`, evidenceRefs: refs };
  }

  private async searchDomainKnowledge(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.domainKnowledge) return failureReceipt('domain_knowledge_unavailable');
    const results = this.options.domainKnowledge.search({
      query: text(args.query),
      limit: integer(args.limit, 6, 1, 12),
    });
    this.noteSearchResult(state.sessionId, results.length === 0);
    const refs = results.map(result => result.evidenceRef);
    state.cognition.knowledgeRefs = [...new Set([...state.cognition.knowledgeRefs, ...refs])];
    return {
      content: { ok: true, knowledge: results },
      summary: `found ${results.length} domain knowledge documents`,
      evidenceRefs: refs,
    };
  }

  private async getDomainKnowledge(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.domainKnowledge) return failureReceipt('domain_knowledge_unavailable');
    const result = this.options.domainKnowledge.get({
      ref: text(args.ref),
      ...(text(args.expectedVersion) ? { expectedVersion: text(args.expectedVersion) } : {}),
      ...(typeof args.maxTokens === 'number' ? { maxTokens: integer(args.maxTokens, 4096, 1, 8192) } : {}),
    });
    const evidenceRefs = result.ok ? [result.document.evidenceRef] : [];
    state.cognition.knowledgeRefs = [...new Set([...state.cognition.knowledgeRefs, ...evidenceRefs])];
    return {
      content: { ok: result.ok, result },
      summary: result.ok ? `loaded domain knowledge ${result.document.id}` : `domain knowledge load failed: ${result.reason}`,
      evidenceRefs,
    };
  }

  private async getSkill(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.skills) return failureReceipt('skill_knowledge_unavailable');
    const result = await this.options.skills.get({
      ref: text(args.ref),
      ...(text(args.expectedVersion) ? { expectedVersion: text(args.expectedVersion) } : {}),
      ...(typeof args.maxTokens === 'number' ? { maxTokens: integer(args.maxTokens, 4096, 1, 8192) } : {}),
    });
    const evidenceRefs = result.ok ? [result.skill.evidenceRef] : [];
    state.cognition.knowledgeRefs = [...new Set([...state.cognition.knowledgeRefs, ...evidenceRefs])];
    return { content: { ok: result.ok, result }, summary: result.ok ? `loaded skill ${result.skill.name}` : `skill load failed: ${result.reason}`, evidenceRefs };
  }

  private async searchCapabilities(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.capabilities) return failureReceipt('capability_knowledge_unavailable');
    const results = this.options.capabilities.search({ query: text(args.query), limit: integer(args.limit, 6, 1, 12) });
    this.noteSearchResult(state.sessionId, results.length === 0);
    return { content: { ok: true, capabilities: results }, summary: `found ${results.length} capabilities`, evidenceRefs: results.map(value => `capability:${value.id}`) };
  }

  private async getCapability(args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.capabilities) return failureReceipt('capability_knowledge_unavailable');
    const result = this.options.capabilities.get(text(args.id));
    return result
      ? { content: { ok: true, capability: result }, summary: `loaded capability ${result.id}`, evidenceRefs: [`capability:${result.id}`] }
      : failureReceipt(`capability_not_found:${text(args.id)}`);
  }

  private async searchMemory(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.tools.memory) return failureReceipt('memory_knowledge_unavailable');
    const result = await this.options.tools.memory.search({
      query: text(args.query),
      limit: integer(args.limit, 6, 1, 12),
    });
    const refs = result.records.map(record => record.id);
    state.cognition.memoryRefs = [...new Set([...state.cognition.memoryRefs, ...refs])];
    return {
      content: {
        ok: true,
        records: result.records.map(record => ({
          ref: record.id,
          kind: record.kind,
          summary: record.summary,
          confidence: record.confidence,
          importance: record.importance,
          evidenceRefs: record.evidenceRefs,
        })),
        gaps: result.gaps,
        traceId: result.traceId,
      },
      summary: `found ${result.records.length} task memories`,
      evidenceRefs: [...new Set([...result.evidenceRefs, `memory-trace:${result.traceId}`])],
    };
  }

  private async getMemory(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    if (!this.options.tools.memory) return failureReceipt('memory_knowledge_unavailable');
    const ref = text(args.ref);
    if (!state.cognition.memoryRefs.includes(ref)) return failureReceipt(`memory_not_loaded:${ref}`);
    const record = await this.options.tools.memory.get(ref);
    return record
      ? {
          content: { ok: true, record },
          summary: `loaded memory ${record.id}`,
          evidenceRefs: [...record.evidenceRefs],
        }
      : failureReceipt(`memory_not_found:${ref}`);
  }

  private async askOwner(state: GoalAgentStateV1, args: Record<string, unknown>): Promise<GoalAgentRoundToolReceipt> {
    const question = text(args.question);
    if (!question) return failureReceipt('owner_ask.question_required');
    const reason = text(args.reason) || 'owner_choice_required';
    const requestedAt = this.now();
    state.owner = { question, answer: null, requestedAt, answeredAt: null };
    state.interpretation.clarificationReason = reason;
    state.verdict = {
      decision: 'need_owner', summary: reason, machineCriteriaSatisfied: false,
      ownerActionable: true, retryable: true, evidenceRefs: [],
    };
    state.phase = 'paused_owner';
    state.activeNode = 'round';
    return { content: { ok: true, paused: true, question, reason }, summary: question, evidenceRefs: [] };
  }

  private requireKnowledge(): GoalKnowledgePort {
    if (!this.options.tools.knowledge) throw new Error('goal knowledge unavailable');
    return this.options.tools.knowledge;
  }
}

interface PlanTaskInput {
  id: string;
  goalText: string;
  successCriteria: Array<Record<string, unknown>>;
  dependsOn: string[];
  taskFamily?: string;
  estimatedActions: number;
  estimatedDurationMs: number;
  risk: number;
}

function parsePlanProposal(args: Record<string, unknown>, maxTasks: number): { tasks: PlanTaskInput[] } | { error: string } {
  if (!Array.isArray(args.tasks) || args.tasks.length < 1) return { error: 'plan tasks array is required' };
  if (args.tasks.length > maxTasks) return { error: `task count exceeds ${maxTasks}` };
  const tasks: PlanTaskInput[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < args.tasks.length; index += 1) {
    const raw = record(args.tasks[index]);
    const id = normalizeId(text(raw.id) || `task-${index + 1}`);
    if (!id || ids.has(id)) return { error: `task ${index + 1} id invalid or duplicated` };
    ids.add(id);
    const goalText = text(raw.goalText);
    if (!goalText) return { error: `task ${id} goalText missing` };
    if (!Array.isArray(raw.successCriteria) || raw.successCriteria.length === 0) return { error: `task ${id} successCriteria missing` };
    const successCriteria = raw.successCriteria.map(value => record(value));
    const unsupported = successCriteria.find(criterion => !SUPPORTED_CRITERION_TYPES.has(text(criterion.type)));
    if (unsupported) return { error: `task ${id} has unsupported criterion ${text(unsupported.type) || 'missing'}` };
    const dependsOn = Array.isArray(raw.dependsOn)
      ? raw.dependsOn.map(value => normalizeId(text(value))).filter(Boolean)
      : [];
    tasks.push({
      id,
      goalText,
      successCriteria,
      dependsOn,
      ...(text(raw.taskFamily) ? { taskFamily: text(raw.taskFamily) } : {}),
      estimatedActions: positive(raw.estimatedActions, 1),
      estimatedDurationMs: positive(raw.estimatedDurationMs, 30_000),
      risk: bounded(raw.risk, 0, 1, 0.2),
    });
  }
  for (const task of tasks) {
    if (task.dependsOn.some(dep => !ids.has(dep) || dep === task.id)) return { error: `task ${task.id} dependency invalid` };
  }
  return { tasks };
}

function bindAuthoritativeDynamicCriterionFields(
  proposed: Record<string, unknown>,
  authoritative: readonly GoalSuccessCriterion[],
): Record<string, unknown> {
  if (typeof proposed.since === 'number' && Number.isFinite(proposed.since)) return proposed;
  const encoded = stableJson(criterionWithoutSince(proposed));
  const match = authoritative.find(criterion => typeof criterion.since === 'number'
    && Number.isFinite(criterion.since)
    && stableJson(criterionWithoutSince(criterion as unknown as Record<string, unknown>)) === encoded);
  return match ? { ...proposed, since: match.since } : proposed;
}

function criterionWithoutSince(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.since;
  return copy;
}

/** Natural-language aliases are accepted at the tool boundary but never persisted as a second domain protocol. */
function normalizeCriterionAliases(value: Record<string, unknown>): Record<string, unknown> {
  if (value.type === 'block_placed' && value.relation === 'underfoot') {
    return { ...value, relation: 'near' };
  }
  return value;
}

function buildPlanGraph(state: GoalAgentStateV1, tasks: PlanTaskInput[], revision: number, maxTasks: number): PlanGraph {
  const refs = [...state.experience.refs];
  const defaultFamily = state.goal.signature?.compatibleTaskFamilies[0] ?? 'general';
  const nodes: PlanNode[] = tasks.map(task => {
    const criteria = task.successCriteria.map(stableJson);
    const goal: GoalContract = {
      id: `${state.rootGoal!.goalId}:${task.id}`,
      goalText: task.goalText,
      successCriteria: criteria,
      taskFamily: task.taskFamily ?? defaultFamily,
      metadata: {
        structuredSuccessCriteria: structuredClone(task.successCriteria),
        rootSuccessCriteria: structuredClone([...state.rootGoal!.successCriteria]),
        goalSignature: state.goal.signature?.key,
        planRevision: revision,
      },
    };
    return {
      id: task.id,
      goal,
      state: task.dependsOn.length === 0 ? 'ready' : 'pending',
      preconditions: task.dependsOn.map(id => `${id} satisfied`),
      postconditions: criteria,
      planRecoveryRefs: [],
      estimatedCost: {
        actions: Math.max(1, Math.ceil(task.estimatedActions)),
        durationMs: Math.max(1_000, Math.ceil(task.estimatedDurationMs)),
        llmRounds: 1,
        risk: task.risk,
      },
      provenance: ['goalagent:round-tool', ...refs],
      experienceRefs: refs,
    };
  });
  return {
    id: `plan-${state.sessionId}`,
    goalId: state.rootGoal!.goalId,
    nodes,
    edges: tasks.flatMap(task => task.dependsOn.map(dep => ({ from: dep, to: task.id, type: 'requires' as const }))),
    budget: { maxNodes: maxTasks, maxGraphReplans: state.budget.maxGraphReplans },
    provenance: ['goalagent:round-tool', ...refs],
  };
}

/**
 * Inventory is a checkpoint, while delivery/deposit/placement/decrease consumes it.
 * Keeping both on one AND node creates a physically unsatisfiable terminal state.
 */
function transientMilestoneIssues(graph: PlanGraph): string[] {
  const consumingTypes = new Set(['block_placed', 'item_delivered', 'item_deposited', 'inventory_decrease']);
  const issues: string[] = [];
  for (const node of graph.nodes) {
    const criteria = (node.goal.metadata?.structuredSuccessCriteria ?? []) as Array<Record<string, unknown>>;
    const inventoryItems = new Set(criteria
      .filter(criterion => criterion.type === 'inventory' && text(criterion.item))
      .map(criterion => text(criterion.item)));
    for (const criterion of criteria) {
      const type = text(criterion.type);
      const item = text(criterion.item);
      if (item && consumingTypes.has(type) && inventoryItems.has(item)) {
        issues.push(`transient_inventory_must_be_separate:${node.id}:${item}:${type}`);
      }
    }
  }
  return issues;
}

function buildCommittedGoal(state: GoalAgentStateV1, args: Record<string, unknown>): { goal: Omit<CommittedAgentGoal, 'successCriteria'> } | { error: string } {
  const outcome = text(args.outcome) as AgentGoalOutcome;
  if (!OUTCOMES.has(outcome)) return { error: 'goal outcome is invalid' };
  const target = record(args.target);
  const kind = text(target.kind) as ParentGoalTargetKind;
  const surface = text(target.surface);
  const registryId = text(target.registryId);
  const quantity = target.quantity;
  if (!KINDS.has(kind) || !surface || !registryId || !Number.isInteger(quantity) || Number(quantity) < 1) {
    return { error: 'goal target requires valid kind, surface, registryId and positive quantity' };
  }
  const modelConstraints = Array.isArray(args.constraints)
    ? args.constraints.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    goal: {
      requestId: state.requestId,
      objective: state.request.requestText,
      outcome,
      target: { kind, surface, registryId, quantity: Number(quantity) },
      constraints: [...new Set([...state.request.constraints, ...modelConstraints].map(value => value.trim()).filter(Boolean))],
    },
  };
}

function commitGoal(input: {
  input: Omit<CommittedAgentGoal, 'successCriteria'>;
  target: GoalTargetDefinition;
  args: Record<string, unknown>;
  profileId: string;
  goalId: string;
  acceptedAt: string;
  signatures: GoalSignatureCompiler;
}): { goal: CommittedAgentGoal; signature: ReturnType<GoalSignatureCompiler['compile']>; rootGoal: GoalContractV1 } | { error: string } {
  if (!outcomeSupportsKind(input.input.outcome, input.target.kind)) return { error: `goal outcome=${input.input.outcome} incompatible with ${input.target.kind}` };
  const acceptedAtMs = Date.parse(input.acceptedAt);
  if (!Number.isFinite(acceptedAtMs)) return { error: 'goal clock returned invalid timestamp' };
  const criteria = successCriteriaFor(input.input, input.target, input.args);
  if ('error' in criteria) return criteria;
  const goal: CommittedAgentGoal = {
    ...input.input,
    successCriteria: criteria.successCriteria.map(criterion => ['item_delivered', 'item_deposited', 'block_placed', 'predicate'].includes(String(criterion.type))
      && (typeof criterion.since !== 'number' || !Number.isFinite(criterion.since))
      ? { ...criterion, since: acceptedAtMs }
      : criterion),
  };
  const signature = input.signatures.compile(goal);
  const rootGoal: GoalContractV1 = {
    schema: GOAL_CONTRACT_SCHEMA_V1,
    goalId: input.goalId,
    profileId: input.profileId,
    goalText: goal.objective,
    successCriteria: structuredClone(goal.successCriteria) as unknown as GoalSuccessCriterion[],
    constraints: goal.constraints.map(value => ({ type: 'natural_language' as const, value })),
    contextRef: `goal-signature:${signature.key}`,
    createdAt: input.acceptedAt,
  };
  return { goal, signature, rootGoal };
}

function successCriteriaFor(
  goal: Omit<CommittedAgentGoal, 'successCriteria'>,
  target: GoalTargetDefinition,
  args: Record<string, unknown>,
): { successCriteria: Array<Record<string, unknown>> } | { error: string } {
  const item = target.registryId.replace(/^minecraft:/, '');
  if (target.successCriteriaPolicy === 'authoritative') {
    if (!target.successCriteria?.length) return { error: `authoritative target has no success criteria: ${target.registryId}` };
    return { successCriteria: materializeTargetCriteria(target, goal.target.quantity) };
  }
  if (goal.outcome === 'deliver' && target.kind === 'item') return { successCriteria: [{ type: 'item_delivered', item, count: goal.target.quantity }] };
  if (goal.outcome === 'deposit' && target.kind === 'item') return { successCriteria: [{ type: 'item_deposited', item, count: goal.target.quantity }] };
  if (goal.outcome === 'obtain' && target.kind === 'item') return { successCriteria: [{ type: 'inventory', item, count: goal.target.quantity }] };
  if (goal.outcome === 'place' && target.kind === 'item') {
    const placement = record(args.placement);
    const relativeTo = text(placement.relativeTo);
    const inputRelation = text(placement.relation);
    const relation = inputRelation === 'underfoot' ? 'near' : inputRelation;
    const radius = typeof placement.radius === 'number' && Number.isFinite(placement.radius) ? Math.max(0.1, placement.radius) : 1.5;
    if (!['owner', 'self'].includes(relativeTo) || !['near', 'right', 'front', 'at', 'underfoot'].includes(relation)) {
      return { error: 'place outcome requires placement.relativeTo and placement.relation' };
    }
    return { successCriteria: [{ type: 'block_placed', item, count: goal.target.quantity, relativeTo, relation, radius }] };
  }
  if (target.successCriteria?.length) {
    return { successCriteria: materializeTargetCriteria(target, goal.target.quantity) };
  }
  return { error: `no machine success criterion registered for ${goal.outcome}:${target.registryId}` };
}

function materializeTargetCriteria(target: GoalTargetDefinition, quantity: number): Array<Record<string, unknown>> {
  return (target.successCriteria ?? []).map(value => value.type === 'inventory'
    ? { type: value.type, item: value.item, count: value.count === '$quantity' ? quantity : value.count }
    : { ...value });
}

function outcomeSupportsKind(outcome: AgentGoalOutcome, kind: ParentGoalTargetKind): boolean {
  if (kind === 'item') return ['obtain', 'deliver', 'deposit', 'place'].includes(outcome);
  if (kind === 'entity') return outcome === 'defeat';
  if (kind === 'location') return outcome === 'reach';
  if (kind === 'structure') return outcome === 'build';
  return outcome === 'explore' || outcome === 'survive';
}

function completeState(state: GoalAgentStateV1, summary: string, evidenceRefs: string[], now: string): void {
  state.verdict = {
    decision: 'complete', summary, machineCriteriaSatisfied: true,
    ownerActionable: false, retryable: false, evidenceRefs: [...new Set(evidenceRefs)],
  };
  state.terminal = {
    outcome: 'completed', summary, completedAt: now, evidenceRefs: [...new Set(evidenceRefs)],
  };
  state.phase = 'completed';
  state.activeNode = 'round';
}

function rootCoverageIssues(plannedCriteria: unknown[], rootCriteria: unknown[]): string[] {
  const planned = new Set(plannedCriteria.map(stableJson));
  return rootCriteria.flatMap(criterion => planned.has(stableJson(criterion)) ? [] : [`root_criterion_not_covered:${stableJson(criterion)}`]);
}

function boundedWorld(world: GoalAgentStateV1['world']['latest']): Record<string, unknown> | null {
  if (!world) return null;
  return {
    tick: world.tick,
    timestamp: world.timestamp,
    self: world.self,
    owner: world.owner,
    inventory: world.inventory,
    environment: world.environment,
    nearbyEntities: world.entities.slice(0, 20).map(entity => ({
      id: entity.id, name: entity.name, category: entity.category, distance: entity.distance, position: entity.position,
    })),
  };
}

function mergeCandidates(state: GoalAgentStateV1, additions: GoalTargetCandidate[]): void {
  const candidates = state.interpretation.candidates.map(value => structuredClone(value));
  const evidence = new Set(state.interpretation.evidenceRefs);
  for (const candidate of additions) {
    const index = candidates.findIndex(value => value.registryId === candidate.registryId);
    if (index >= 0) candidates[index] = structuredClone(candidate);
    else candidates.push(structuredClone(candidate));
    evidence.add(candidate.evidenceRef);
  }
  state.interpretation.candidates = candidates;
  state.interpretation.evidenceRefs = [...evidence];
}

function asCandidate(target: GoalTargetDefinition): GoalTargetCandidate {
  return { ...structuredClone(target), evidenceRef: `goal-target:${target.registryId}` };
}

function actionKey(state: GoalAgentStateV1, candidateId: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${state.sessionId}:${state.epoch}:${state.plan.revision}:${state.plan.activeNodeId}:${candidateId}:${stableJson(args)}`)
    .digest('hex');
}

function failureReceipt(error: string): GoalAgentRoundToolReceipt {
  return { content: { ok: false, error }, summary: error, evidenceRefs: [] };
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function optionalKind(value: unknown): ParentGoalTargetKind | undefined {
  const kind = text(value) as ParentGoalTargetKind;
  return KINDS.has(kind) ? kind : undefined;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function abortError(): Error {
  const error = new Error('GoalAgent round tool aborted');
  error.name = 'AbortError';
  return error;
}
