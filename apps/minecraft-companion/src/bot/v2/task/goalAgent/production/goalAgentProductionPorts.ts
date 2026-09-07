import type { GoalBodyExecutionPort } from '../../execution/bodyActionService.js';
import { isDeepStrictEqual } from 'node:util';
import { tuning } from '../../../infra/tuning.js';
import type { RuntimeActionCandidateProvider, RuntimeWorldFactProvider } from '../../../plugin-kernel/runtimeProjection.js';
import type { WorldStateView } from '../../../types.js';
import { evaluateGoalCriteriaState } from '../../goalRunner/goalCriteriaEvaluator.js';
import type { Goal, GoalSuccessCriterion } from '../../contracts/goalTypes.js';
import { ActionPreparer } from '../../execution/actionPreparer.js';
import type { GenerationContractResolverPort } from '../../execution/generationResolversPorts.js';
import { failureDetail, failureFromLegacy } from '../../execution/failureEnvelope.js';
import type { FailureEnvelope } from '../../contracts/failureEnvelope.js';
import type { PlannerExperienceFreezeResult } from '../../planner/experience/plannerExperienceProvider.js';
import type { GoalAgentActionResult, GoalAgentStateV1 } from '../goalAgentState.js';
import type { GoalAgentActionCandidate, GoalAgentExecutionPort } from '../ports/executionPort.js';
import { candidateBinding, prepareCandidateArguments } from '../goalAgentCandidateAuthority.js';
import { observeRequestedWorldFacts } from './goalAgentFactObservation.js';
import type { WorldFactRequest } from '../../contracts/worldFact.js';
import type { RegistrySnapshotRef } from '../../../plugin-sdk/identity.js';
import type { GoalPlanAuthorizationPort } from '../ports/goalPlanPort.js';
import type {
  GoalAgentExperiencePort,
  GoalAgentExperienceProposal,
} from '../ports/experiencePort.js';
import type { GoalAgentPerceptionPort } from '../ports/perceptionPort.js';
import type {
  GoalAgentVerificationPort,
  GoalAgentVerificationResult,
} from '../ports/verificationPort.js';

export interface GatherTarget {
  pos: { x: number; y: number; z: number };
  blockName: string;
  toolName?: string;
}

export interface GoalAgentProductionExecutionOptions {
  body: GoalBodyExecutionPort;
  parentTaskId: (sessionId: string) => string | null;
  actionProviders?: (snapshot: Readonly<GoalAgentStateV1>['snapshotRef']) => readonly RuntimeActionCandidateProvider[];
  plans?: GoalPlanAuthorizationPort;
  maxCandidates?: number;
  log?: (message: string) => void;
  /** P3-4 · 唯一原子合同源；缺失时组合根构造失败，不允许默认 Registry 兜底。 */
  contractResolver: GenerationContractResolverPort;
  behaviorResolver: import('../../execution/generationResolversPorts.js').GenerationBehaviorResolverPort;
}

export class GoalAgentProductionExecutionPort implements GoalAgentExecutionPort {
  private readonly preparer: ActionPreparer;

  constructor(private readonly options: GoalAgentProductionExecutionOptions) {
    this.preparer = new ActionPreparer(options.contractResolver);
  }

  async listCandidates(input: {
    state: Readonly<GoalAgentStateV1>;
    planNodeId?: string;
    includeUnavailable?: boolean;
    signal: AbortSignal;
  }): Promise<GoalAgentActionCandidate[]> {
    const node = input.planNodeId
      ? input.state.plan.graph?.nodes.find(value => value.id === input.planNodeId)
      : undefined;
    const root = input.state.rootGoal;
    const world = input.state.world.latest;
    if ((!node && !root) || !world || input.signal.aborted) return [];
    const criteria = node
      ? structuredCriteria(node.goal.metadata?.structuredSuccessCriteria)
      : [...root!.successCriteria];
    const goalText = node?.goal.goalText ?? root!.goalText;
    const registeredCandidates = await this.registeredProviderCandidates({
      state: input.state,
      ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
      criteria,
      goalText,
      world,
      signal: input.signal,
    });
    return filterAndCap(registeredCandidates, input.state, this.options.maxCandidates, input.includeUnavailable);
  }

  isOwnerNeedActionable(input: { missingInformation: string; state: Readonly<GoalAgentStateV1> }): boolean {
    const text = input.missingInformation.toLowerCase();
    if (input.state.action.result?.failure?.ownerActionable === true) return true;
    return /(which|where exactly|coordinate|主人选择|具体位置|哪一种|哪个目标)/i.test(text);
  }

  execute(input: Parameters<GoalAgentExecutionPort['execute']>[0]) {
    if (input.state.progress?.waiting) throw new Error('action_session_waiting_world');
    if (input.state.rootGoal?.schema !== 'mineclaw.goal/v2') throw new Error('needs_rebind:formal_goal_required');
    if (!input.candidate || !this.options.plans) throw new Error('goal_execution_authority_required');
    this.options.plans.authorize(input.state, input.candidate, input.proposal.args);
    if (input.candidate) {
      if (input.proposal.source !== input.candidate.source || input.proposal.action !== input.candidate.action) {
        throw new Error('action_executor_identity_changed');
      }
      const validated = prepareCandidateArguments(input.candidate, input.proposal.args);
      if (!isDeepStrictEqual(validated, input.proposal.args)) throw new Error('action_bound_arguments_missing');
    }
    return this.executeOnce(input);
  }

  private async executeOnce(input: Parameters<GoalAgentExecutionPort['execute']>[0]) {
    const startedAt = new Date().toISOString();
    const executionSessionId = `execution:${input.idempotencyKey}`;
    const parentId = this.options.parentTaskId(input.sessionId);
    let ok = false;
    let detail = '';
    let failure: FailureEnvelope | undefined;
    const bodyEvidence:string[]=[];
    try {
      if (input.signal.aborted) throw abortError();
      if (input.proposal.action === 'invoke_task' || input.proposal.action === 'invoke_strategy') {
        failure = failureFromLegacy('legacy_execution_source_removed', { origin: 'decision', stage: 'preparing' });
      } else {
        /* Plugin candidates execute only through the Generation-bound body path. */
        const prepared = input.proposal.action === 'invoke_behavior'
          ? prepareBehaviorAction(input.proposal, executionSessionId, parentId)
          : this.preparer.prepare(input.proposal, {
              execId: executionSessionId,
              ...(parentId ? { taskId: parentId } : {}),
              snapshot: input.state.snapshotRef,
            });
        if (prepared.kind === 'invalid') {
          failure = prepared.failure;
        } else {
          if (!parentId) throw new Error('goal_body_owner_missing');
          const result = await this.options.body.executeGoal(prepared.request,{
            operationId:executionSessionId,state:input.state,taskId:parentId,signal:input.signal,
          });
          if(result.kind==='operation') bodyEvidence.push(`body-operation:${result.receipt.operationId}:${result.receipt.status}`);
          failure = result.kind==='operation' && result.receipt.failure
            ? result.receipt.failure
            : input.proposal.action === 'invoke_behavior'
              ? (result.ok ? undefined : failureFromLegacy(result.error))
              : input.state.snapshotRef
                ? this.preparer.normalize(input.state.snapshotRef, input.proposal.action, result) ?? undefined
                : failureFromLegacy('needs_rebind:goal_snapshot_missing');
          ok = result.ok && !failure;
          detail = failure ? failureDetail(failure) : `action ${input.proposal.action} completed`;
        }
      }
    } catch (error) {
      failure = failureFromLegacy(error instanceof Error ? error.message : String(error));
    }
    if (failure) {
      ok = false;
      detail = detail || failureDetail(failure);
    }
    const completedAt = new Date().toISOString();
    const result:GoalAgentActionResult = {
      executionSessionId,
      idempotencyKey: input.idempotencyKey,
      ok,
      detail: detail || (ok ? 'action completed' : 'action failed'),
      startedAt,
      completedAt,
      ...(failure ? { failure } : {}),
      evidenceRefs: [
        `action:${input.idempotencyKey}:${ok ? 'ok' : 'failed'}`,
        ...(input.proposal.action === 'invoke_task' && detail ? [`task-action:${detail}`] : []),
        ...(failure?.evidenceRefs ?? []),
        ...bodyEvidence,
      ],
    };
    return result;
  }

  private async registeredProviderCandidates(
    input: Parameters<RuntimeActionCandidateProvider['list']>[0],
  ): Promise<GoalAgentActionCandidate[]> {
    const candidates: GoalAgentActionCandidate[] = [];
    for (const provider of [...(this.options.actionProviders?.(input.state.snapshotRef) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      if (input.signal.aborted) return [];
      try {
        const listed = await provider.list(input);
        for (const candidate of [...listed].sort((a, b) => a.id.localeCompare(b.id))) {
          if (this.isRegisteredProviderCandidate(candidate, input.state)) candidates.push(candidate);
          else this.options.log?.(`capability candidate rejected: ${provider.id}/${candidate.id}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.options.log?.(`capability candidate provider failed closed: ${provider.id}: ${detail}`);
      }
    }
    return candidates;
  }

  private isRegisteredProviderCandidate(candidate: GoalAgentActionCandidate, state: Readonly<GoalAgentStateV1>): boolean {
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || typeof candidate.action !== 'string' || !candidate.action.trim()) return false;
    if (candidate.authorization && !['ready', 'blocked', 'unknown'].includes(candidate.authorization.status)) return false;
    if (!state.snapshotRef || !candidate.operationRef || candidate.action !== 'invoke_behavior') return false;
    const behaviorId = String(candidate.fixedArgs.behavior ?? '');
    const resolved = this.options.behaviorResolver.resolve(state.snapshotRef, candidate.operationRef);
    return candidate.kind === 'behavior' && candidate.source === 'registered_behavior'
      && behaviorId === candidate.operationRef.contributionId && resolved.status === 'resolved';
  }
}

export class GoalAgentProductionPerceptionPort implements GoalAgentPerceptionPort {
  constructor(
    private readonly observeWorld: () => Promise<WorldStateView> | WorldStateView,
    private readonly worldFactProviders: (snapshot?: RegistrySnapshotRef) => readonly RuntimeWorldFactProvider[] = () => [],
  ) {}
  async observe(signal: AbortSignal, factRequests: readonly WorldFactRequest[] = [], snapshot?: RegistrySnapshotRef): Promise<WorldStateView> {
    if (signal.aborted) throw abortError();
    const world = await this.observeWorld();
    if (signal.aborted) throw abortError();
    if (!factRequests.length) return world;
    const facts = await observeRequestedWorldFacts(world, factRequests, this.worldFactProviders(snapshot), signal);
    return { ...structuredClone(world), capabilityFacts: facts };
  }
}

export class GoalAgentProductionVerificationPort implements GoalAgentVerificationPort {
  constructor(
    private readonly deliveries: () => Array<{ item: string; count: number; at: number; ref?: string }>,
    private readonly deposits: () => Array<{
      item: string; count: number; at: number;
      position: { x: number; y: number; z: number }; ref?: string;
    }> = () => [],
    private readonly placements: () => Array<{
      item:string; count:number; at:number;
      position:{x:number;y:number;z:number}; relativeTo:'owner'|'self';
      referencePosition:{x:number;y:number;z:number}; referenceYaw?:number;
      relation:'near'|'right'|'front'|'at'; ref?:string;
    }> = () => [],
    private readonly predicateEvaluators: (state: Readonly<GoalAgentStateV1>) => readonly import('../../goalRunner/goalCriteriaEvaluator.js').GoalPredicateEvaluator[] = () => [],
    private readonly observeFacts: (
      state: Readonly<GoalAgentStateV1>,
      world: WorldStateView,
      signal: AbortSignal,
    ) => Promise<readonly import('../../contracts/worldFact.js').WorldFact[]> = async () => [],
  ) {}

  async verifyTask(input: { state: Readonly<GoalAgentStateV1>; planNodeId: string }): Promise<GoalAgentVerificationResult> {
    const node = input.state.plan.graph?.nodes.find(value => value.id === input.planNodeId);
    if (!node) return { ok: false, detail: 'active plan task not found', evidenceRefs: [] };
    const world = await this.worldWithFacts(input.state);
    const verdict = evaluateGoalCriteriaState({
      goalText: node.goal.goalText,
      successCriteria: structuredCriteria(node.goal.metadata?.structuredSuccessCriteria),
    }, world, {
      deliveries: this.deliveries(), deposits: this.deposits(), placements: this.placements(),
      predicateEvaluators: this.predicateEvaluators(input.state),
    });
    return { ok: verdict.status === 'satisfied', status: verdict.status, detail: verdict.detail, evidenceRefs: verdict.evidenceRefs ?? [] };
  }

  async verifyRoot(input: { state: Readonly<GoalAgentStateV1> }): Promise<GoalAgentVerificationResult> {
    if (!input.state.rootGoal) return { ok: false, detail: 'root goal missing', evidenceRefs: [] };
    const root = input.state.rootGoal;
    if (root.schema !== 'mineclaw.goal/v2') return { ok: false, status: 'unknown', detail: 'needs_rebind:formal_goal_required', evidenceRefs: [] };
    if (input.state.world.latest?.environment.dimension !== root.scope.dimension) {
      return { ok: false, status: 'unknown', detail: 'root_goal_dimension_mismatch', evidenceRefs: [] };
    }
    const world = await this.worldWithFacts(input.state);
    const verdict = evaluateGoalCriteriaState(
      { goalText: root.goalText, successCriteria: [...root.successCriteria] },
      world,
      {
        deliveries: this.deliveries(), deposits: this.deposits(), placements: this.placements(),
        predicateEvaluators: this.predicateEvaluators(input.state),
      },
    );
    return { ok: verdict.status === 'satisfied', status: verdict.status, detail: verdict.detail, evidenceRefs: verdict.evidenceRefs ?? [] };
  }

  private async worldWithFacts(state: Readonly<GoalAgentStateV1>): Promise<WorldStateView | null> {
    const world = state.world.latest;
    if (!world || !state.snapshotRef) return world;
    const signal = new AbortController().signal;
    const facts = await this.observeFacts(state, world, signal);
    return { ...structuredClone(world), capabilityFacts: facts };
  }
}

export class GoalAgentProductionExperiencePort implements GoalAgentExperiencePort {
  private readonly proposals = new Map<string, string>();

  constructor(
    private readonly freezeExperience: (input: Parameters<GoalAgentExperiencePort['freeze']>[0]) => PlannerExperienceFreezeResult,
    private readonly publishProposal?: (proposal: GoalAgentExperienceProposal) => void,
  ) {}

  freeze(input: Parameters<GoalAgentExperiencePort['freeze']>[0]): PlannerExperienceFreezeResult {
    return this.freezeExperience(input);
  }

  commitProposal(proposal: GoalAgentExperienceProposal): { proposalId: string } {
    const existing = this.proposals.get(proposal.idempotencyKey);
    if (existing) return { proposalId: existing };
    const proposalId = `experience-proposal:${proposal.sessionId}:${this.proposals.size + 1}`;
    this.proposals.set(proposal.idempotencyKey, proposalId);
    this.publishProposal?.(structuredClone(proposal));
    return { proposalId };
  }
}

function structuredCriteria(value: unknown): GoalSuccessCriterion[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as GoalSuccessCriterion[]
    : [];
}

function applicableAtomicArgs(
  action: string,
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
): Record<string, unknown> | null {
  const inventory = criteria.find(value => value.type === 'inventory');
  if (inventory?.item && action === 'craft') {
    // BUG-CROSS-80 · craft 原子按"能力存在"暴露：itemName 不预填，由模型填目标物或所需工具；
    // 原子层 RecipeResolver 递归补料，缺料返回结构化错误形成 ReAct 闭环。
    const target = inventory.count ?? 1;
    return { count: Math.max(1, target - inventoryCount(world, inventory.item)), inventoryTargetCount: target };
  }
  const delivered = criteria.find(value => value.type === 'item_delivered');
  if (delivered?.item && action === 'toss_item') return { itemName: delivered.item, count: delivered.count ?? 1 };
  const decreased = criteria.find(value => value.type === 'inventory_decrease');
  if (decreased?.item && action === 'toss_item') return { itemName: decreased.item, count: decreased.count ?? 1 };
  const reached = criteria.find(value => value.type === 'reached');
  const reachedTarget = reached?.position
    ?? (reached?.relativeTo === 'owner' ? world.owner?.position : undefined);
  if (reachedTarget && (action === 'move_to' || action === 'goto_position')) {
    return { position: structuredClone(reachedTarget) };
  }
  const dead = criteria.find(value => value.type === 'entity_dead');
  const target = dead ? world.entities.find(entity =>
    (dead.entityId && String(entity.id) === dead.entityId)
    || (dead.entityName && entity.name === dead.entityName)) : undefined;
  if (target && ['attack', 'combat_round', 'crit_jump_attack', 'bow_shoot'].includes(action)) {
    return { entityId: target.id };
  }
  return null;
}

function inventoryCriterion(criteria: GoalSuccessCriterion[]) {
  return criteria.find(value => value.type === 'inventory');
}

function managedInventoryTaskCandidates(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
  canCraftTarget: boolean,
  canGather: boolean,
): GoalAgentActionCandidate[] {
  const inventory = inventoryCriterion(criteria);
  if (!inventory?.item) return [];
  const target = Math.max(1, inventory.count ?? 1);
  if (inventoryCount(world, inventory.item) >= target) return [];
  const candidates: GoalAgentActionCandidate[] = [];
  // BUG-CROSS-80 · craft_item 不再被 canCraft(目标物) 门控：任何 inventory 缺口都暴露合成任务，
  // 模型可把 item 改为所需工具/中间物；ProvisionStrategy + RecipeResolver 递归补料并结构化失败闭环。
  candidates.push({
    id: `task:craft_item:${inventory.item}`,
    kind: 'task',
    source: 'registered_task',
    action: 'invoke_task',
    description: canCraftTarget
      ? `Run the registered recursive crafting task for ${inventory.item}`
      : `Run the registered recursive crafting task (item defaults to ${inventory.item}; the model may override item to craft a required tool or intermediate)`,
    fixedArgs: { taskKind: 'craft_item', params: { item: inventory.item, count: target } },
    mutableArgumentPaths: ['/params/item', '/params/count'],
    argumentSchema: {
      type: 'object',
      properties: {
        taskKind: { type: 'string', enum: ['craft_item'] },
        params: {
          type: 'object',
          properties: { item: { type: 'string', minLength: 1 }, count: positiveCount() },
          additionalProperties: false,
        },
      },
      required: ['taskKind', 'params'],
      additionalProperties: false,
    },
    evidenceRefs: ['task-capability:craft_item'],
  });
  if (canGather) {
    candidates.push({
      id: `task:gather_material:${inventory.item}`,
      kind: 'task',
      source: 'registered_task',
      action: 'invoke_task',
      description: `Run the registered gathering task for ${inventory.item}, including bounded exploration`,
      fixedArgs: { taskKind: 'gather_material', params: { material: inventory.item, count: target } },
      mutableArgumentPaths: ['/params/count'],
      argumentSchema: {
        type: 'object',
        properties: {
          taskKind: { type: 'string', enum: ['gather_material'] },
          params: {
            type: 'object',
            properties: { material: { type: 'string', minLength: 1 }, count: positiveCount() },
            additionalProperties: false,
          },
        },
        required: ['taskKind', 'params'],
        additionalProperties: false,
      },
      evidenceRefs: ['task-capability:gather_material'],
    });
  }
  return candidates;
}

function validateManagedTask(
  taskKind: string,
  params: Record<string, unknown>,
): { ok: true; taskKind: 'gather_material' | 'craft_item'; params: Record<string, unknown> }
  | { ok: false; detail: string } {
  const count = Number(params.count ?? 1);
  if (!Number.isFinite(count) || count < 1) return { ok: false, detail: 'managed_task_invalid_count' };
  if (taskKind === 'gather_material') {
    const material = typeof params.material === 'string' ? params.material.trim() : '';
    return material
      ? { ok: true, taskKind, params: { material, count: Math.floor(count) } }
      : { ok: false, detail: 'managed_task_material_missing' };
  }
  if (taskKind === 'craft_item') {
    const item = typeof params.item === 'string' ? params.item.trim() : '';
    return item
      ? { ok: true, taskKind, params: { item, count: Math.floor(count) } }
      : { ok: false, detail: 'managed_task_item_missing' };
  }
  return { ok: false, detail: `managed_task_kind_not_allowed:${taskKind}` };
}

function inventoryCount(world: WorldStateView, item: string): number {
  return world.inventory.items.filter(value => value.name === item).reduce((sum, value) => sum + value.count, 0);
}

function uniqueCandidates(candidates: GoalAgentActionCandidate[]): GoalAgentActionCandidate[] {
  const unique = new Map<string, GoalAgentActionCandidate>();
  for (const candidate of candidates) {
    const previous = unique.get(candidate.id);
    if (!previous) unique.set(candidate.id, structuredClone(candidate));
    else if (!isDeepStrictEqual(candidateBinding(previous), candidateBinding(candidate))) {
      // An ID collision cannot silently change which executable the agent authorizes.
      previous.authorization = { status: 'blocked', reasons: ['candidate_identity_conflict'] };
    } else previous.evidenceRefs = [...new Set([...previous.evidenceRefs, ...candidate.evidenceRefs])].sort();
  }
  return [...unique.values()];
}

function filterAndCap(
  candidates: GoalAgentActionCandidate[],
  state: Readonly<GoalAgentStateV1>,
  maxCandidates: number | undefined,
  includeUnavailable = false,
): GoalAgentActionCandidate[] {
  const unique = uniqueCandidates(candidates);
  const filtered = state.verdict?.decision === 'revise_action' && state.action.result?.failure
    ? unique.filter(candidate => !matchesFailedProposal(candidate, state.action.proposal))
    : unique;
  const configured = maxCandidates ?? tuning().capabilityCatalog.searchLimit;
  const limit = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : tuning().capabilityCatalog.searchLimit;
  const ready = filtered.filter(candidate => !candidate.authorization || candidate.authorization.status === 'ready');
  const unavailable = filtered.filter(candidate => candidate.authorization && candidate.authorization.status !== 'ready');
  return [...ready.slice(0, limit), ...(includeUnavailable ? unavailable.slice(0, limit) : [])];
}

function positiveCount(): Record<string, unknown> { return { type: 'integer', minimum: 1 }; }

function behaviorInvocationSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['behavior', 'behaviorParams'],
    properties: {
      behavior: { type: 'string', minLength: 1 },
      behaviorParams: { type: 'object' },
    },
  };
}

function prepareBehaviorAction(
  proposal: import('../../../atomic/contracts/atomicContractRegistry.js').ActionProposal,
  executionSessionId: string,
  parentTaskId: string | null,
): import('../../execution/actionPreparer.js').ActionPrepareResult {
  const behavior = typeof proposal.args.behavior === 'string' ? proposal.args.behavior.trim() : '';
  const behaviorParams = plainRecord(proposal.args.behaviorParams);
  if (!behavior) {
    return { kind: 'invalid', failure: failureFromLegacy('behavior_id_required', { origin: 'behavior', stage: 'preparing' }) };
  }
  return {
    kind: 'ready',
    action: { proposal, target: { behavior, behaviorParams }, derivedFields: [], contractVersion: 1 },
    request: {
      id: executionSessionId,
      source: `goalagent.${proposal.source}`,
      ...(parentTaskId ? { taskId: parentTaskId } : {}),
      type: 'invoke_behavior',
      priority: 35,
      interrupt_level: 'soft',
      resource: [],
      target: { behavior, behaviorParams },
      preconditions: [],
      timeout_ms: 30_000,
    },
  };
}

function craftArgumentSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['itemName'],
    properties: {
      itemName: { type: 'string', minLength: 1 }, count: positiveCount(), inventoryTargetCount: positiveCount(),
      needTable: { type: 'boolean' },
    },
  };
}

function chestRetrievalNeed(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
  requestText: string,
): { item: string; count: number } | null {
  if (!hasContainerSourceSemantics(requestText)) return null;
  const inventory = criteria.find(value => value.type === 'inventory' && value.item);
  if (!inventory?.item) return null;
  const missing = Math.max(0, (inventory.count ?? 1) - inventoryCount(world, inventory.item));
  return missing > 0 ? { item: inventory.item, count: missing } : null;
}

/**
 * A container noun alone does not make the container an item source. In
 * particular, "Craft a chest" names the output and must stay on the generic
 * recipe/craft path. Retrieval needs an explicit source relation.
 */
function hasContainerSourceSemantics(text: string): boolean {
  const chineseSourceFirst = /(?:从|到|去|在).{0,32}(?:箱子|箱|容器)(?:里|中|内|旁|附近)?[^。！？!?]{0,24}(?:拿|取|找|带出|搬出)/;
  const chineseContainerFirst = /(?:箱子|箱|容器)(?:里|中|内|里的|中的|内的)[^。！？!?]{0,24}(?:拿|取|找|带|搬)/;
  const englishActionFirst = /\b(?:withdraw|retrieve|take|get|bring|fetch|remove)\b[^.!?]{0,80}\b(?:from|out of|inside)\b[^.!?]{0,50}\b(?:chest|container)\b/i;
  const englishContainerFirst = /\b(?:go to|at|in|inside)\b[^.!?]{0,60}\b(?:chest|container)\b[^.!?]{0,60}\b(?:withdraw|retrieve|take|get|bring|fetch|remove)\b/i;
  return chineseSourceFirst.test(text)
    || chineseContainerFirst.test(text)
    || englishActionFirst.test(text)
    || englishContainerFirst.test(text);
}

function deliveryNeed(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
): { item: string; count: number } | null {
  const delivered = criteria.find(value => value.type === 'item_delivered' && value.item);
  if (!delivered?.item || !world.owner?.position) return null;
  const count = delivered.count ?? 1;
  return inventoryCount(world, delivered.item) >= count ? { item: delivered.item, count } : null;
}

function groundPickupNeed(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
): { item: string; count: number; entityId: number; position: { x: number; y: number; z: number } } | null {
  const inventory = criteria.find(value => value.type === 'inventory' && value.item);
  if (!inventory?.item) return null;
  const missing = Math.max(0, (inventory.count ?? 1) - inventoryCount(world, inventory.item));
  if (missing === 0) return null;
  const target = world.entities
    .filter(entity => entity.droppedItem?.name === inventory.item && (entity.droppedItem?.count ?? 0) > 0)
    .sort((left, right) => left.distance - right.distance)[0];
  if (!target?.droppedItem) return null;
  return {
    item: inventory.item,
    count: Math.min(missing, target.droppedItem.count),
    entityId: target.id,
    position: structuredClone(target.position),
  };
}

function depositNeed(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
  requestText: string,
): { item: string; count: number } | null {
  if (!/(?:箱子|箱|容器|\bchest\b|\bcontainer\b)/i.test(requestText)) return null;
  const deposited = criteria.find(value => value.type === 'item_deposited' && value.item);
  if (!deposited?.item) return null;
  const count = deposited.count ?? 1;
  return inventoryCount(world, deposited.item) >= count ? { item: deposited.item, count } : null;
}

function placementNeed(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
  requestText: string,
): {
  item:string; count:number; relativeTo:'owner'|'self'; relation:'near'|'right'|'front'|'at'; radius:number;
  surface:'ground'|'top';
} | null {
  const placed = criteria.find(value => value.type === 'block_placed' && value.item);
  if (!placed?.item || (placed.relativeTo !== 'owner' && placed.relativeTo !== 'self')) return null;
  if (placed.relativeTo === 'owner' && !world.owner?.position) return null;
  if (placed.relativeTo === 'self' && !world.self?.position) return null;
  const count = placed.count ?? 1;
  if (inventoryCount(world, placed.item) < count) return null;
  // Older/in-flight sessions may contain the public input alias `underfoot`.
  // Candidate execution uses one canonical relation so the alias cannot hide
  // an otherwise valid placement tool after the inventory milestone succeeds.
  const relation = canonicalPlacementRelation(placed.relation);
  if (!relation) return null;
  return {
    item: placed.item,
    count,
    relativeTo: placed.relativeTo,
    relation,
    radius: placed.radius ?? 1.5,
    surface: placementSurface(requestText),
  };
}

function canonicalPlacementRelation(value: unknown): 'near'|'right'|'front'|'at'|null {
  if (value === 'underfoot') return 'near';
  return value === 'near' || value === 'right' || value === 'front' || value === 'at'
    ? value
    : null;
}

function placementSurface(text: string): 'ground'|'top' {
  return /(?:石头|石块|方块|块|桌|台|箱子|箱)(?:的)?(?:上|上面|顶部)|(?:放|摆|插|种)(?:在|到).{0,24}(?:上|上面|顶部)|\b(?:on top of|on the (?:block|stone|table|chest)|atop)\b/i.test(text)
    ? 'top'
    : 'ground';
}

function containerTargetText(nodeGoalText: string, rootGoalText: string): string {
  return /(?:箱子|箱|容器|\bchest\b|\bcontainer\b)/i.test(nodeGoalText)
    ? nodeGoalText
    : rootGoalText;
}

function positionKey(value: { x: number; y: number; z: number }): string {
  return `${value.x}:${value.y}:${value.z}`;
}

function matchesFailedProposal(
  candidate: GoalAgentActionCandidate,
  proposal: GoalAgentStateV1['action']['proposal'],
): boolean {
  if (!proposal || candidate.action !== proposal.action) return false;
  return Object.entries(candidate.fixedArgs).every(([key, value]) => isDeepStrictEqual(proposal.args[key], value));
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
}

function abortError(): Error {
  const error = new Error('GoalAgent action aborted');
  error.name = 'AbortError';
  return error;
}
