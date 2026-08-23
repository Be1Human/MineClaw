import type { AtomicContext } from '../../../atomic/atomics.js';
import { executeAtomic } from '../../../atomic/atomics.js';
import { isDeepStrictEqual } from 'node:util';
import { createDefaultAtomicContractRegistry } from '../../../atomic/contracts/defaultContracts.js';
import type { IBehaviorRegistry } from '../../../behavior/types.js';
import type { CapabilityActionCandidateProvider } from '../../../capabilities/types.js';
import type { WorldStateView } from '../../../types.js';
import { atomDisplayLabel } from '../../goalRunner/atomExec.js';
import { evaluateGoalCriteria } from '../../goalRunner/goalCriteriaEvaluator.js';
import type { Goal, GoalSuccessCriterion } from '../../contracts/goalTypes.js';
import { legacyGoalFromContract } from '../../contracts/goalContract.js';
import { ActionPreparer } from '../../execution/actionPreparer.js';
import { failureDetail, failureFromLegacy, type FailureEnvelope } from '../../execution/failureEnvelope.js';
import type { PlannerExperienceFreezeResult } from '../../planner/experience/plannerExperienceProvider.js';
import { StrategyExecutor } from '../../strategy/strategyExecutor.js';
import { StrategyMatcher } from '../../strategy/strategyMatcher.js';
import type { StrategyStore } from '../../strategy/strategyStore.js';
import type { TaskRuntime } from '../../taskRuntime.js';
import type { GoalAgentActionResult, GoalAgentStateV1 } from '../goalAgentState.js';
import type { GoalAgentActionCandidate, GoalAgentExecutionPort } from '../ports/executionPort.js';
import type { GoalAgentActionLedgerPort } from './goalAgentActionLedger.js';
import type { ChestTarget } from './containerTargetResolver.js';
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
  atomicContext: () => AtomicContext;
  behaviors: IBehaviorRegistry;
  tasks: TaskRuntime;
  parentTaskId: (sessionId: string) => string | null;
  resolveGatherTargets?: (item: string, world: WorldStateView) => GatherTarget[];
  resolveChestTargets?: (item: string, count: number, requestText: string, world: WorldStateView) => ChestTarget[];
  strategyStore?: StrategyStore;
  categorizeTarget?: (bind: Record<string, unknown>, world: WorldStateView) => string[];
  actionLedger?: GoalAgentActionLedgerPort;
  actionProviders?: readonly CapabilityActionCandidateProvider[];
  maxCandidates?: number;
  log?: (message: string) => void;
}

export class GoalAgentProductionExecutionPort implements GoalAgentExecutionPort {
  private readonly contracts = createDefaultAtomicContractRegistry();
  private readonly preparer = new ActionPreparer(this.contracts);
  private readonly cache = new Map<string, Promise<Awaited<ReturnType<GoalAgentExecutionPort['execute']>>>>();
  private readonly strategyMatcher?: StrategyMatcher;
  private readonly strategyExecutor?: StrategyExecutor;

  constructor(private readonly options: GoalAgentProductionExecutionOptions) {
    if (options.strategyStore) {
      this.strategyMatcher = new StrategyMatcher({
        usable: () => options.strategyStore!.usable(),
        ...(options.categorizeTarget ? { categorizeTarget: options.categorizeTarget } : {}),
        onLog: options.log,
      });
      this.strategyExecutor = new StrategyExecutor({
        atom: {
          atomicCtx: options.atomicContext,
          backingTaskId: () => null,
        },
        getStrategy: id => options.strategyStore!.get(id),
        getWorld: () => options.atomicContext().worldState ?? null,
        onLog: options.log,
      });
    }
  }

  async listCandidates(input: {
    state: Readonly<GoalAgentStateV1>;
    planNodeId?: string;
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
    const goal: Goal = {
      goalText,
      successCriteria: criteria,
      constraints: input.state.rootGoal?.constraints?.map(value => value.value).join('\n'),
    };
    const candidates: GoalAgentActionCandidate[] = [];
    const requestText = input.state.rootGoal?.goalText ?? goalText;
    const registeredCandidates = await this.registeredProviderCandidates({
      state: input.state,
      ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
      criteria,
      goalText,
      world,
      signal: input.signal,
    });
    if (registeredCandidates.length > 0) {
      return filterAndCap(registeredCandidates, input.state, this.options.maxCandidates);
    }
    const containerText = containerTargetText(goalText, requestText);
    const chestRetrieval = chestRetrievalNeed(criteria, world, containerText);
    const groundPickup = groundPickupNeed(criteria, world);
    const delivery = deliveryNeed(criteria, world);
    const deposit = depositNeed(criteria, world, containerText);
    const placement = placementNeed(criteria, world, requestText);

    if (groundPickup) {
      const behaviorAvailable = this.options.behaviors.list().some(behavior => behavior.id === 'pickup_ground_item');
      if (behaviorAvailable) {
        candidates.push({
          id: `behavior:pickup_ground_item:${groundPickup.entityId}`,
          kind: 'behavior',
          source: 'registered_behavior',
          action: 'invoke_behavior',
          description: `Approach and pick up grounded ${groundPickup.item}`,
          fixedArgs: {
            behavior: 'pickup_ground_item',
            behaviorParams: {
              item: groundPickup.item,
              count: groundPickup.count,
              itemEntityId: groundPickup.entityId,
              position: structuredClone(groundPickup.position),
            },
          },
          argumentSchema: this.contracts.get('invoke_behavior')?.schema as unknown as Record<string, unknown>,
          evidenceRefs: [`ground-item:${groundPickup.entityId}:${groundPickup.item}`],
        });
      }
      return filterAndCap(candidates, input.state, this.options.maxCandidates);
    }

    if (delivery) {
      const behaviorAvailable = this.options.behaviors.list().some(behavior => behavior.id === 'deliver_to_owner');
      if (behaviorAvailable) {
        candidates.push({
          id: `behavior:deliver_to_owner:${delivery.item}`,
          kind: 'behavior',
          source: 'registered_behavior',
          action: 'invoke_behavior',
          description: `Approach the owner and deliver ${delivery.count} ${delivery.item}`,
          fixedArgs: {
            behavior: 'deliver_to_owner',
            behaviorParams: { item: delivery.item, count: delivery.count },
          },
          argumentSchema: this.contracts.get('invoke_behavior')?.schema as unknown as Record<string, unknown>,
          evidenceRefs: [`delivery-target:owner:${world.owner!.username}`],
        });
      }
      return filterAndCap(candidates, input.state, this.options.maxCandidates);
    }

    if (deposit) {
      const behaviorAvailable = this.options.behaviors.list().some(behavior => behavior.id === 'deposit_to_chest');
      const targets = behaviorAvailable
        ? this.options.resolveChestTargets?.(deposit.item, deposit.count, containerText, world) ?? []
        : [];
      for (const target of targets) {
        candidates.push({
          id: `behavior:deposit_to_chest:${positionKey(target.pos)}`,
          kind: 'behavior',
          source: 'registered_behavior',
          action: 'invoke_behavior',
          description: `Deposit ${deposit.count} ${deposit.item} into the ${target.relation} chest`,
          fixedArgs: {
            behavior: 'deposit_to_chest',
            behaviorParams: { chestPos: target.pos, item: deposit.item, count: deposit.count },
          },
          argumentSchema: this.contracts.get('invoke_behavior')?.schema as unknown as Record<string, unknown>,
          evidenceRefs: [`container-target:${target.relation}:${positionKey(target.pos)}`],
        });
      }
      return filterAndCap(candidates, input.state, this.options.maxCandidates);
    }

    if (chestRetrieval) {
      const behaviorAvailable = this.options.behaviors.list().some(behavior => behavior.id === 'withdraw_from_chest');
      const targets = behaviorAvailable
        ? this.options.resolveChestTargets?.(chestRetrieval.item, chestRetrieval.count, requestText, world) ?? []
        : [];
      for (const target of targets) {
        candidates.push({
          id: `behavior:withdraw_from_chest:${positionKey(target.pos)}`,
          kind: 'behavior',
          source: 'registered_behavior',
          action: 'invoke_behavior',
          description: `Withdraw ${chestRetrieval.count} ${chestRetrieval.item} from the ${target.relation} chest`,
          fixedArgs: {
            behavior: 'withdraw_from_chest',
            behaviorParams: { chestPos: target.pos, item: chestRetrieval.item, count: chestRetrieval.count },
          },
          argumentSchema: this.contracts.get('invoke_behavior')?.schema as unknown as Record<string, unknown>,
          evidenceRefs: [`container-target:${target.relation}:${positionKey(target.pos)}`],
        });
      }
      return filterAndCap(candidates, input.state, this.options.maxCandidates);
    }

    if (placement) {
      const behaviorAvailable = this.options.behaviors.list()
        .some(behavior => behavior.id === 'place_relative');
      if (behaviorAvailable) {
        candidates.push({
          id: `behavior:place_relative:${placement.relativeTo}:${placement.item}:${placement.relation}${placement.surface === 'top' ? ':top' : ''}`,
          kind: 'behavior',
          source: 'registered_behavior',
          action: 'invoke_behavior',
          description: `Place ${placement.item} ${placement.relation} the ${placement.relativeTo} reference`,
          fixedArgs: {
            behavior: 'place_relative',
            behaviorParams: {
              item: placement.item,
              count: placement.count,
              relativeTo: placement.relativeTo,
              relation: placement.relation,
              radius: placement.radius,
              ...(placement.surface === 'top' ? { surface: placement.surface } : {}),
            },
          },
          argumentSchema: this.contracts.get('invoke_behavior')?.schema as unknown as Record<string, unknown>,
          evidenceRefs: [`placement-target:${placement.relativeTo}:${placement.relation}`],
        });
      }
      return filterAndCap(candidates, input.state, this.options.maxCandidates);
    }

    const strategy = this.strategyMatcher && this.strategyExecutor
      ? await this.strategyMatcher.resolve(goal, world)
      : null;
    if (strategy) {
      candidates.push({
        id: `strategy:${strategy.strategy.id}`,
        kind: 'strategy',
        source: 'fast_strategy',
        action: 'invoke_strategy',
        description: strategy.strategy.description,
        fixedArgs: { strategyId: strategy.strategy.id, bind: strategy.bind },
        evidenceRefs: [`strategy:${strategy.strategy.id}`],
      });
    }

    const inventoryItem = inventoryCriterion(criteria)?.item;
    const recipes = inventoryItem
      ? this.craftRecipes(inventoryItem)
      : [];
    const managedTask = managedInventoryTaskCandidate(
      criteria,
      world,
      recipes.length > 0,
      inventoryItem ? this.hasGatherSource(inventoryItem) : false,
    );
    if (managedTask) candidates.push(managedTask);
    for (const behavior of this.options.behaviors.list()) {
      for (const candidate of this.behaviorCandidates(behavior.id, criteria, world, recipes.length > 0)) {
        candidates.push(candidate);
      }
    }
    for (const definition of this.contracts.list()) {
      const fixedArgs = applicableAtomicArgs(definition.action, criteria, world, recipes.length > 0);
      if (!fixedArgs) continue;
      candidates.push({
        id: `atomic:${definition.action}`,
        kind: 'atomic',
        source: 'slow_llm',
        action: definition.action,
        description: `Execute one registered atomic action: ${definition.action}`,
        fixedArgs,
        argumentSchema: definition.schema as unknown as Record<string, unknown>,
        evidenceRefs: [`atomic-contract:${definition.action}`],
      });
    }
    return filterAndCap(candidates, input.state, this.options.maxCandidates);
  }

  isOwnerNeedActionable(input: { missingInformation: string; state: Readonly<GoalAgentStateV1> }): boolean {
    const text = input.missingInformation.toLowerCase();
    if (input.state.action.result?.failure?.ownerActionable === true) return true;
    return /(which|where exactly|coordinate|主人选择|具体位置|哪一种|哪个目标)/i.test(text);
  }

  execute(input: Parameters<GoalAgentExecutionPort['execute']>[0]) {
    const existing = this.cache.get(input.idempotencyKey);
    if (existing) return existing;
    const operation = this.executeOnce(input);
    this.cache.set(input.idempotencyKey, operation);
    return operation;
  }

  private async executeOnce(input: Parameters<GoalAgentExecutionPort['execute']>[0]) {
    const startedAt = new Date().toISOString();
    const executionSessionId = `execution:${input.idempotencyKey}`;
    const replay = this.options.actionLedger?.begin({
      idempotencyKey:input.idempotencyKey,
      sessionId:input.sessionId,
      epoch:input.epoch,
      proposal:input.proposal,
      startedAt,
    });
    if(replay?.status==='completed')return replay.result;
    if(replay?.status==='in_doubt')return interruptedActionResult(
      input.idempotencyKey,executionSessionId,replay.startedAt,
    );
    const parentId = this.options.parentTaskId(input.sessionId);
    const mirrorId = parentId && input.proposal.action !== 'invoke_task'
      ? this.options.tasks.mirrorStart(
          input.proposal.action,
          input.proposal.args,
          parentId,
          atomDisplayLabel(input.proposal.action, input.proposal.args),
        )
      : null;
    let ok = false;
    let detail = '';
    let failure: FailureEnvelope | undefined;
    try {
      if (input.signal.aborted) throw abortError();
      if (input.proposal.action === 'invoke_task') {
        const taskResult = await this.executeManagedTask(input, parentId);
        ok = taskResult.ok;
        detail = taskResult.detail;
        failure = taskResult.failure;
      } else if (input.proposal.action === 'invoke_strategy') {
        const strategyId = String(input.proposal.args.strategyId ?? '');
        const bind = plainRecord(input.proposal.args.bind);
        const strategy = this.options.strategyStore?.get(strategyId);
        if (!strategy || !this.strategyExecutor) {
          failure = failureFromLegacy(`strategy_not_found:${strategyId}`, { origin: 'decision', stage: 'preparing' });
        } else {
          const result = await this.strategyExecutor.run(strategy, bind, () => input.signal.aborted);
          ok = result.status === 'success';
          detail = result.detail ?? result.status;
          if (!ok) failure = failureFromLegacy(detail, { origin: 'behavior', stage: 'executing' });
          this.options.strategyStore?.recordRun(strategyId, {
            ok,
            downgraded: !ok,
            durationMs: Date.parse(new Date().toISOString()) - Date.parse(startedAt),
          });
        }
      } else {
        const prepared = this.preparer.prepare(input.proposal, {
          execId: executionSessionId,
          ...(parentId ? { taskId: parentId } : {}),
        });
        if (prepared.kind === 'invalid') {
          failure = prepared.failure;
        } else {
          const result = await executeAtomic(prepared.request, this.options.atomicContext());
          failure = this.preparer.normalize(input.proposal.action, result) ?? undefined;
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
    if (mirrorId) this.options.tasks.mirrorFinish(mirrorId, ok, detail);
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
      ],
    };
    this.options.actionLedger?.complete(result);
    return result;
  }

  private async executeManagedTask(
    input: Parameters<GoalAgentExecutionPort['execute']>[0],
    parentId: string | null,
  ): Promise<{ ok: boolean; detail: string; failure?: FailureEnvelope }> {
    if (!parentId) {
      const failure = failureFromLegacy('goal_task_parent_missing', { origin: 'decision', stage: 'preparing' });
      return { ok: false, detail: failureDetail(failure), failure };
    }
    const taskKind = String(input.proposal.args.taskKind ?? '');
    const params = plainRecord(input.proposal.args.params);
    const validated = validateManagedTask(taskKind, params);
    if (!validated.ok) {
      const failure = failureFromLegacy(validated.detail, { origin: 'decision', stage: 'preparing' });
      return { ok: false, detail: failureDetail(failure), failure };
    }

    const task = this.options.tasks.createSubtask({
      kind: validated.taskKind,
      params: { ...validated.params, _timeoutMs: 110_000 },
      priority: validated.taskKind === 'craft_item' ? 56 : 55,
    }, parentId);
    return new Promise(resolve => {
      const bus = this.options.atomicContext().bus;
      let settled = false;
      const unsubscribers: Array<() => void> = [];
      const finish = (result: { ok: boolean; detail: string; failure?: FailureEnvelope }): void => {
        if (settled) return;
        settled = true;
        for (const unsubscribe of unsubscribers) unsubscribe();
        input.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const matchingPayload = (payload: unknown): Record<string, unknown> | null => {
        const record = plainRecord(payload);
        return record.taskId === task.id ? record : null;
      };
      unsubscribers.push(bus.on('task.completed', event => {
        if (!matchingPayload(event.payload)) return;
        finish({ ok: true, detail: `${validated.taskKind}:${task.id}:completed` });
      }));
      unsubscribers.push(bus.on('task.failed', event => {
        const payload = matchingPayload(event.payload);
        if (!payload) return;
        const legacy = `${String(payload.code ?? 'task_failed')}:${String(payload.detail ?? payload.reason ?? validated.taskKind)}`;
        const failure = failureFromLegacy(legacy, { origin: 'behavior', stage: 'executing' });
        finish({ ok: false, detail: `${validated.taskKind}:${task.id}:failed:${legacy}`, failure });
      }));
      unsubscribers.push(bus.on('task.cancelled', event => {
        const payload = matchingPayload(event.payload);
        if (!payload) return;
        const legacy = `task_cancelled:${String(payload.reason ?? validated.taskKind)}`;
        const failure = failureFromLegacy(legacy, { origin: 'infra', stage: 'executing' });
        finish({ ok: false, detail: `${validated.taskKind}:${task.id}:cancelled`, failure });
      }));
      const onAbort = (): void => {
        const live = this.options.tasks.getById(task.id);
        if (live && live.state !== 'completed' && live.state !== 'failed' && live.state !== 'cancelled') {
          this.options.tasks.cancel(task.id, 'goalagent_action_aborted');
        } else {
          const failure = failureFromLegacy('goalagent_action_aborted', { origin: 'infra', stage: 'executing' });
          finish({ ok: false, detail: `${validated.taskKind}:${task.id}:aborted`, failure });
        }
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      else this.options.tasks.pushToStack(task.id);
    });
  }

  private behaviorCandidates(
    behaviorId: string,
    criteria: GoalSuccessCriterion[],
    world: WorldStateView,
    canCraft: boolean,
  ): GoalAgentActionCandidate[] {
    const base = {
      kind: 'behavior' as const,
      source: 'registered_behavior' as const,
      action: 'invoke_behavior',
      description: `Execute registered behavior ${behaviorId}`,
      argumentSchema: this.contracts.get('invoke_behavior')?.schema as unknown as Record<string, unknown>,
      evidenceRefs: [`behavior:${behaviorId}`],
    };
    const inventory = criteria.find(value => value.type === 'inventory');
    if (behaviorId === 'gather_block' && inventory?.item && !canCraft) {
      const targets = this.options.resolveGatherTargets?.(inventory.item, world) ?? [];
      return targets.slice(0, 4).map((target, index) => ({
        ...base,
        id: `behavior:gather_block:${index + 1}`,
        fixedArgs: { behavior: behaviorId, behaviorParams: target },
      }));
    }
    if (behaviorId === 'craft_one' && inventory?.item && canCraft) {
      const have = inventoryCount(world, inventory.item);
      const target = inventory.count ?? 1;
      return [{
        ...base,
        id: `behavior:${behaviorId}`,
        fixedArgs: {
          behavior: behaviorId,
          behaviorParams: { item: inventory.item, count: Math.max(1, target - have), inventoryTargetCount: target },
        },
      }];
    }
    if (behaviorId === 'combat') {
      const dead = criteria.find(value => value.type === 'entity_dead');
      const target = world.entities.find(entity =>
        (dead?.entityId && String(entity.id) === dead.entityId)
        || (dead?.entityName && entity.name === dead.entityName));
      if (!dead || !target) return [];
      return [{
        ...base,
        id: `behavior:${behaviorId}:${target.id}`,
        fixedArgs: {
          behavior: behaviorId,
          behaviorParams: { targetEntityId: target.id, targetEntityName: target.name },
        },
      }];
    }
    return [];
  }

  private craftRecipes(item: string) {
    try {
      return this.options.atomicContext().game.getCraftRecipes(item, true);
    } catch {
      return [];
    }
  }

  private hasGatherSource(item: string): boolean {
    try {
      return Boolean(this.options.atomicContext().game.getItemSource(item));
    } catch {
      return false;
    }
  }

  private async registeredProviderCandidates(
    input: Parameters<CapabilityActionCandidateProvider['list']>[0],
  ): Promise<GoalAgentActionCandidate[]> {
    const candidates: GoalAgentActionCandidate[] = [];
    for (const provider of this.options.actionProviders ?? []) {
      if (input.signal.aborted) return [];
      try {
        const listed = await provider.list(input);
        for (const candidate of listed) {
          if (this.isRegisteredProviderCandidate(candidate)) candidates.push(structuredClone(candidate));
          else this.options.log?.(`capability candidate rejected: ${provider.id}/${candidate.id}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.options.log?.(`capability candidate provider failed closed: ${provider.id}: ${detail}`);
      }
    }
    return candidates;
  }

  private isRegisteredProviderCandidate(candidate: GoalAgentActionCandidate): boolean {
    if (!candidate.id.trim() || !candidate.action.trim()) return false;
    if (candidate.action === 'invoke_strategy') return Boolean(this.options.strategyStore?.get(
      String(candidate.fixedArgs.strategyId ?? ''),
    ));
    if (!this.contracts.get(candidate.action)) return false;
    if (candidate.action !== 'invoke_behavior') return true;
    const behaviorId = String(candidate.fixedArgs.behavior ?? '');
    return Boolean(behaviorId && this.options.behaviors.get(behaviorId));
  }
}

export class GoalAgentProductionPerceptionPort implements GoalAgentPerceptionPort {
  constructor(private readonly observeWorld: () => Promise<WorldStateView> | WorldStateView) {}
  async observe(signal: AbortSignal): Promise<WorldStateView> {
    if (signal.aborted) throw abortError();
    const world = await this.observeWorld();
    if (signal.aborted) throw abortError();
    return world;
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
    private readonly predicateEvaluators: () => readonly import('../../goalRunner/goalCriteriaEvaluator.js').GoalPredicateEvaluator[] = () => [],
  ) {}

  verifyTask(input: { state: Readonly<GoalAgentStateV1>; planNodeId: string }): GoalAgentVerificationResult {
    const node = input.state.plan.graph?.nodes.find(value => value.id === input.planNodeId);
    if (!node) return { ok: false, detail: 'active plan task not found', evidenceRefs: [] };
    const verdict = evaluateGoalCriteria({
      goalText: node.goal.goalText,
      successCriteria: structuredCriteria(node.goal.metadata?.structuredSuccessCriteria),
    }, input.state.world.latest, {
      deliveries: this.deliveries(), deposits: this.deposits(), placements: this.placements(),
      predicateEvaluators: this.predicateEvaluators(),
    });
    return { ok: verdict.ok, detail: verdict.detail, evidenceRefs: verdict.evidenceRefs ?? [] };
  }

  verifyRoot(input: { state: Readonly<GoalAgentStateV1> }): GoalAgentVerificationResult {
    if (!input.state.rootGoal) return { ok: false, detail: 'root goal missing', evidenceRefs: [] };
    const verdict = evaluateGoalCriteria(
      legacyGoalFromContract(input.state.rootGoal),
      input.state.world.latest,
      {
        deliveries: this.deliveries(), deposits: this.deposits(), placements: this.placements(),
        predicateEvaluators: this.predicateEvaluators(),
      },
    );
    return { ok: verdict.ok, detail: verdict.detail, evidenceRefs: verdict.evidenceRefs ?? [] };
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
  canCraft: boolean,
): Record<string, unknown> | null {
  const inventory = criteria.find(value => value.type === 'inventory');
  if (inventory?.item && action === 'craft' && canCraft) {
    const target = inventory.count ?? 1;
    return { itemName: inventory.item, count: Math.max(1, target - inventoryCount(world, inventory.item)), inventoryTargetCount: target };
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
  if (target && ['attack', 'crit_jump_attack', 'kite', 'bow_shoot'].includes(action)) {
    return { entityId: target.id };
  }
  return null;
}

function inventoryCriterion(criteria: GoalSuccessCriterion[]) {
  return criteria.find(value => value.type === 'inventory');
}

function managedInventoryTaskCandidate(
  criteria: GoalSuccessCriterion[],
  world: WorldStateView,
  canCraft: boolean,
  canGather: boolean,
): GoalAgentActionCandidate | null {
  const inventory = inventoryCriterion(criteria);
  if (!inventory?.item) return null;
  const target = Math.max(1, inventory.count ?? 1);
  if (inventoryCount(world, inventory.item) >= target) return null;
  if (!canCraft && !canGather) return null;
  const taskKind = canCraft ? 'craft_item' : 'gather_material';
  const params = canCraft
    ? { item: inventory.item, count: target }
    : { material: inventory.item, count: target };
  return {
    id: `task:${taskKind}:${inventory.item}`,
    kind: 'task',
    source: 'registered_task',
    action: 'invoke_task',
    description: canCraft
      ? `Run the registered recursive crafting task for ${inventory.item}`
      : `Run the registered gathering task for ${inventory.item}, including bounded exploration`,
    fixedArgs: { taskKind, params },
    argumentSchema: {
      type: 'object', properties: {}, required: ['taskKind', 'params'], additionalProperties: false,
    },
    evidenceRefs: [`task-capability:${taskKind}`],
  };
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
  return [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()];
}

function filterAndCap(
  candidates: GoalAgentActionCandidate[],
  state: Readonly<GoalAgentStateV1>,
  maxCandidates: number | undefined,
): GoalAgentActionCandidate[] {
  const unique = uniqueCandidates(candidates);
  const filtered = state.verdict?.decision === 'revise_action' && state.action.result?.failure
    ? unique.filter(candidate => !matchesFailedProposal(candidate, state.action.proposal))
    : unique;
  return filtered.slice(0, Math.max(1, maxCandidates ?? 12));
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

function interruptedActionResult(
  idempotencyKey:string,
  executionSessionId:string,
  startedAt:string,
):GoalAgentActionResult {
  const completedAt=new Date().toISOString();
  const evidenceRef=`action:${idempotencyKey}:in_doubt`;
  return {
    executionSessionId,idempotencyKey,ok:false,startedAt,completedAt,
    detail:'process restarted after action dispatch; observe world before choosing a retry',
    failure:{
      code:'execution.result_unknown',origin:'infra',stage:'executing',category:'transient',
      retryable:true,ownerActionable:false,evidenceRefs:[evidenceRef],
      detail:'action result was not checkpointed before restart',
    },
    evidenceRefs:[evidenceRef],
  };
}

function abortError(): Error {
  const error = new Error('GoalAgent action aborted');
  error.name = 'AbortError';
  return error;
}
