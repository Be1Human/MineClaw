import { randomUUID } from 'node:crypto';
import type { GameAdapter } from '../../../adapter/GameAdapter.js';
import type { NavigationAdapter } from '../../../adapter/NavigationAdapter.js';
import type { EventBusV2 } from '../../infra/eventBus.js';
import { tuning } from '../../infra/tuning.js';
import type { ActionRequest, ExecutionResult, WorldStateView } from '../../types.js';
import type { TaskRuntime } from '../taskRuntime.js';
import type { ContributionRef } from '../../plugin-sdk/identity.js';
import type { ExecutionOwner, OperationIntent, OperationCommand } from '../contracts/bodyOperation.js';
import type { BoundGoalScope } from '../contracts/goalDraft.js';
import type { GoalAgentStateV1 } from '../goalAgent/goalAgentState.js';
import type { OperationHandle } from './ports/bodyExecution.js';
import type { OperationReceipt } from '../contracts/operationReceipt.js';
import { BodyAdmissionError, BodyExecutionRuntime } from './bodyExecutionRuntime.js';
import { ExecutionAuthority } from './executionAuthority.js';
import { GameBodyDriver } from './gameBodyDriver.js';
import { actionCommand } from './actionCommand.js';
import { failureDetail } from './failureEnvelope.js';
import type { GenerationAtomicEntryPort, GenerationBehaviorResolverPort } from './generationResolversPorts.js';
import type { OperationLedgerPort } from './operationLedger.js';

export type BodyActionResult =
  | (ExecutionResult & {kind:'operation';receipt:OperationReceipt})
  | (ExecutionResult & {kind:'control'|'rejected';receipt:null});
export interface GoalBodyRequest {
  operationId: string; state: Readonly<GoalAgentStateV1>; taskId: string; signal: AbortSignal;
}
export interface GoalBodyExecutionPort {
  executeGoal(request:ActionRequest,input:GoalBodyRequest):Promise<BodyActionResult>;
  drainTask(taskId:string,reason:string):Promise<void>;
}
export interface ActivityBodyRequest {
  readonly taskId: string;
  readonly operationId: string;
  readonly snapshot: import('../../plugin-sdk/identity.js').RegistrySnapshotRef;
  readonly atomicId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly priority: number;
  readonly signal: AbortSignal;
}
interface RunningAction { request: ActionRequest; intent: OperationIntent; handle: OperationHandle }

/** Trusted activity boundary. Request metadata never mints an owner or a physical lease. */
export class BodyActionService {
  readonly runtime: BodyExecutionRuntime;
  private readonly authority = new ExecutionAuthority();
  private readonly driver: GameBodyDriver;
  private readonly ownerEpochs = new Map<string, number>();
  private readonly operations = new Map<string, RunningAction>();
  private readonly unsubs: Array<() => void> = [];
  constructor(private readonly deps: {
    game: GameAdapter; nav: NavigationAdapter; bus: EventBusV2;
    tasks: TaskRuntime; getWorld(): WorldStateView; isEmbodied(): boolean;
    getGoalState(sessionId: string): GoalAgentStateV1 | null;
    /** P3-4 · 当前已发布插件代快照（Task/Safety 命令的代际来源；Goal 命令固定自身 snapshotRef）。 */
    getSnapshot(): import('../../plugin-sdk/identity.js').RegistrySnapshotRef;
    /** P3-4 · 原子存在性经固定代解析（Driver accepts 用，不建立第二执行中枢）。 */
    atomicResolver: GenerationAtomicEntryPort;
    behaviorResolver: GenerationBehaviorResolverPort;
    hostApiVersion: string;
    ledger: OperationLedgerPort;
  }) {
    this.driver = new GameBodyDriver({ ...deps, atomicResolver: deps.atomicResolver });
    this.runtime = new BodyExecutionRuntime({driver:this.driver,authority:this.authority,ledger:deps.ledger});
    for (const task of deps.tasks.list()) if (task.state==='running') this.ownerEpochs.set(task.id,1);
    for (const type of ['task.started','task.resumed','task.paused','task.completed','task.failed','task.cancelled']) {
      this.unsubs.push(deps.bus.on(type,event => {
        const id = (event.payload as {taskId?:string}).taskId;
        if (!id) return;
        this.ownerEpochs.set(id,(this.ownerEpochs.get(id) ?? 0)+1);
        for (const operation of this.operations.values()) {
          if (operation.intent.owner.taskId===id) operation.handle.cancel(type);
        }
      }));
    }
  }

  currentRequest(): ActionRequest | null {
    for (const value of this.operations.values()) if (this.runtime.inspect(value.intent.operationId)?.state!=='settled') return value.request;
    return null;
  }
  busy(): boolean { return this.runtime.active().length>0; }
  supports(command:OperationCommand):boolean { return this.driver.accepts(command); }

  async executeTask(request: ActionRequest): Promise<BodyActionResult> {
    if (request.type==='say') return this.speech(request);
    const id = request.taskId;
    const ownerEpoch = id ? this.ownerEpochs.get(id) : undefined;
    if (!id || !ownerEpoch || !this.deps.tasks.isRunning(id)) return this.rejected(request,'body_task_owner_not_running');
    if (request.type==='stop' || request.type==='stop_follow') return this.stopTask(request,id);
    const owner: ExecutionOwner = {kind:'task',taskId:id,ownerEpoch};
    return this.execute(request,{owner,operationId:`task-action:${randomUUID()}`,scope:this.worldScope(),
      expectedEffects:[],isCurrent:()=>this.deps.tasks.isRunning(id) && this.ownerEpochs.get(id)===ownerEpoch});
  }

  async executeGoal(request: ActionRequest, input: GoalBodyRequest): Promise<BodyActionResult> {
    const {state,taskId,signal} = input;
    const owner: ExecutionOwner = {kind:'goal',taskId,sessionId:state.sessionId,epoch:state.epoch,planRevision:state.plan.revision};
    const isCurrent = () => {
      const live = this.deps.getGoalState(state.sessionId);
      return !signal.aborted && this.deps.tasks.isRunning(taskId) && !!live
        && live.epoch===owner.epoch && live.plan.revision===owner.planRevision && live.phase==='running';
    };
    if (state.rootGoal?.schema !== 'mineclaw.goal/v2') return this.rejected(request, 'needs_rebind:formal_goal_required');
    const active = state.plan.graph?.nodes.find(node => node.id === state.plan.activeNodeId);
    const expectedEffects = active?.causal?.satisfies ?? state.rootGoal.successCriteria.map(({ since: _since, ...criterion }) => criterion);
    return this.execute(request,{owner,operationId:input.operationId,scope:state.rootGoal.scope,expectedEffects,isCurrent,signal,
      // P3-4 · 固定编译快照；旧记录（无 snapshotRef）→ needs_rebind fail-closed。
      snapshot: state.snapshotRef});
  }

  /** Persistent plugin activities submit finite atomics under one task owner and pinned Generation. */
  async executeActivity(input: ActivityBodyRequest): Promise<BodyActionResult> {
    const ownerEpoch = this.ownerEpochs.get(input.taskId);
    const request = activityAction(input);
    if (!ownerEpoch || !this.deps.tasks.isRunning(input.taskId)) {
      return this.rejected(request, 'body_activity_owner_not_running');
    }
    return this.execute(request, {
      owner: { kind: 'task', taskId: input.taskId, ownerEpoch },
      operationId: input.operationId,
      scope: this.worldScope(),
      expectedEffects: [],
      isCurrent: () => !input.signal.aborted && this.deps.tasks.isRunning(input.taskId) && this.ownerEpochs.get(input.taskId) === ownerEpoch,
      signal: input.signal,
      snapshot: input.snapshot,
    });
  }

  cancelAll(reason: string): void {
    for (const operation of this.operations.values()) operation.handle.cancel(reason);
  }

  async drainAll(reason:string):Promise<void> {
    const pending=[...this.operations.values()];
    this.cancelAll(reason);
    const receipts=await Promise.all(pending.map(value=>value.handle.result));
    if(receipts.some(value=>!value.stop)) throw new Error('body_stop_unconfirmed');
  }

  async drainTask(taskId: string, reason: string): Promise<void> {
    const matching = [...this.operations.values()].filter(value=>value.intent.owner.taskId===taskId);
    for (const value of matching) value.handle.cancel(reason);
    const receipts = await Promise.all(matching.map(value=>value.handle.result));
    if (receipts.some(value=>!value.stop)) throw new Error('body_stop_unconfirmed');
  }

  close(): Promise<void> {
    const pending = [...this.operations.values()].map(value => value.handle.result);
    this.cancelAll('runtime_closed');
    for (const unsubscribe of this.unsubs) unsubscribe();
    return Promise.allSettled(pending).then(() => undefined);
  }

  private async execute(request: ActionRequest, policy: {
    owner: ExecutionOwner; operationId: string; scope: BoundGoalScope;
    expectedEffects: OperationIntent['expectedEffects']; isCurrent(): boolean; signal?: AbortSignal;
    /** P3-4 · Goal 命令的代际快照（state.snapshotRef；缺失=旧记录 needs_rebind fail-closed）。 */
    snapshot?: import('../../plugin-sdk/identity.js').RegistrySnapshotRef;
  }): Promise<BodyActionResult> {
    const start = Date.now();
    try {
      if (!this.deps.isEmbodied()) throw new Error('game_body_unavailable');
      const dimension=policy.scope.dimension;
      // Goal 命令锁定编译时快照；Task 命令用组合根注入的当前代快照。绝不回退 live registry。
      const snapshot = policy.snapshot ?? (policy.owner.kind === 'goal'
        ? failRebind('goal_snapshot_missing')
        : this.deps.getSnapshot());
      const contribution = request.type === 'invoke_behavior'
        ? resolveBehaviorContribution(this.deps.behaviorResolver, snapshot, String(request.target?.behavior ?? ''))
        : resolveAtomicContribution(this.deps.atomicResolver, snapshot, request.type);
      const intent: OperationIntent = {
        operationId:policy.operationId,owner:policy.owner,command:actionCommand(request, contribution, snapshot),
        expectedEffects:policy.expectedEffects,scope:policy.scope,
        deadlineAt:start+Math.min(request.timeout_ms,tuning().controlledExecution.operationTimeoutMs),
        budget:{maxActions:tuning().controlledExecution.maxSubActions},priority:request.priority,
        preemption:request.interrupt_level==='hard' ? 'request':'none',
      };
      const grant = this.authority.issue(intent,{
        isCurrent:()=>this.deps.isEmbodied() && policy.isCurrent()
          && this.deps.getWorld().environment.dimension===dimension,
        allowsChild:command=>command.ref.id.startsWith('atomic:') && this.driver.accepts(command),
      });
      let handle: OperationHandle;
      try { handle = this.runtime.submit({intent,grant}); }
      catch (error) {
        if (!(error instanceof BodyAdmissionError) || error.code!=='body_resources_busy' || intent.preemption!=='request') throw error;
        const conflicts = error.conflicts.map(id=>this.operations.get(id)).filter((v):v is RunningAction=>!!v);
        if (conflicts.length!==error.conflicts.length || conflicts.some(v=>v.intent.priority>=intent.priority)) throw error;
        const receipts = await Promise.all(conflicts.map(v=>v.handle.result));
        if (receipts.some(value=>!value.stop)) throw new Error('body_stop_unconfirmed');
        handle = this.runtime.submit({intent,grant});
      }
      this.operations.set(intent.operationId,{request,intent,handle});
      const cancel = () => handle.cancel('activity_aborted');
      policy.signal?.addEventListener('abort',cancel,{once:true});
      if (policy.signal?.aborted) cancel();
      try {
        const receipt = await handle.result;
        this.deps.bus.publish('body.operation_receipt',receipt.status==='succeeded' ? 'info':'recoverable',receipt);
        return {kind:'operation',ok:receipt.status==='succeeded',request,durationMs:Date.now()-start,receipt,
          ...(receipt.status!=='succeeded' ? {error:receipt.failure ? failureDetail(receipt.failure):receipt.status}: {})};
      } finally {
        policy.signal?.removeEventListener('abort',cancel);
        // Quarantine remains visible and retains ownership after a result timeout.
        const snapshot = this.runtime.inspect(intent.operationId);
        const managed = this.runtime.active().some(value => value.operationId === intent.operationId);
        if (!snapshot || snapshot.state === 'settled' || !managed) this.operations.delete(intent.operationId);
      }
    } catch (error) { return this.rejected(request,error instanceof Error ? error.message:String(error)); }
  }
  private worldScope(): BoundGoalScope {
    return {dimension:this.deps.getWorld().environment.dimension,targetRefs:[],bindings:[]};
  }
  private rejected(request: ActionRequest,error: string): BodyActionResult { return {kind:'rejected',receipt:null,ok:false,request,error,durationMs:0}; }
  private async stopTask(request: ActionRequest, id: string): Promise<BodyActionResult> {
    try { await this.drainTask(id,'task_stop'); return {kind:'control',receipt:null,ok:true,request,durationMs:0}; }
    catch (error) { return this.rejected(request,String(error)); }
  }
  private speech(request: ActionRequest): BodyActionResult {
    const text = String(request.target?.text ?? '').trim();
    if (!text) return this.rejected(request,'say requires target.text');
    this.deps.bus.publish('brain.notice','suggestion',{source:request.source,topic:'atomic_speech_request',
      label:'执行层请求发言',detail:text,status:'info',wake:request.priority>=60,dedupeKey:`atomic_say:${request.source}:${text}`});
    return {kind:'control',receipt:null,ok:true,request,durationMs:0};
  }
}

/** P3-4 · Goal 命令没有固定快照 = 旧持久记录；fail-closed needs_rebind，不转查最新代。 */
function failRebind(reason: string): never {
  throw new Error(`needs_rebind:${reason}`);
}

/** P3-4 · 原子贡献引用经固定代解析；in_doubt（代内缺失/未知原子）→ fail-closed。 */
function resolveAtomicContributionFail(reason: string): never {
  throw new Error(`needs_rebind:${reason}`);
}

function resolveAtomicContribution(
  resolver: GenerationAtomicEntryPort,
  snapshot: import('../../plugin-sdk/identity.js').RegistrySnapshotRef,
  actionType: string,
): import('../../plugin-sdk/identity.js').ContributionRef {
  const entry = resolver.resolve(snapshot, actionType);
  if (entry.status === 'in_doubt') {
    return resolveAtomicContributionFail(`atomic_contribution_missing:${actionType}:${entry.reason}`);
  }
  return entry.value.contribution;
}

function resolveBehaviorContribution(
  resolver: GenerationBehaviorResolverPort,
  snapshot: import('../../plugin-sdk/identity.js').RegistrySnapshotRef,
  behaviorId: string,
): ContributionRef {
  if (!behaviorId) throw new Error('behavior_id_required');
  const entry = resolver.resolveById(snapshot, behaviorId);
  if (entry.status === 'in_doubt') throw new Error(`needs_rebind:behavior_contribution_missing:${behaviorId}:${entry.reason}`);
  return entry.value.contribution;
}

function activityAction(input: ActivityBodyRequest): ActionRequest {
  return {
    id: input.operationId,
    source: 'plugin_activity',
    taskId: input.taskId,
    type: input.atomicId as ActionRequest['type'],
    priority: input.priority,
    interrupt_level: 'soft',
    resource: [],
    target: structuredClone(input.args) as ActionRequest['target'],
    preconditions: [],
    timeout_ms: Math.max(1, Math.min(input.timeoutMs ?? tuning().controlledExecution.operationTimeoutMs, tuning().controlledExecution.operationTimeoutMs)),
  };
}
