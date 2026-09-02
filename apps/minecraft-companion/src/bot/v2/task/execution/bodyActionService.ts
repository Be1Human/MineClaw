import { randomUUID } from 'node:crypto';
import type { GameAdapter } from '../../../adapter/GameAdapter.js';
import type { NavigationAdapter } from '../../../adapter/NavigationAdapter.js';
import type { IBehaviorRegistry } from '../../behavior/types.js';
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
interface RunningAction { request: ActionRequest; intent: OperationIntent; handle: OperationHandle }

/** Trusted activity boundary. Request metadata never mints an owner or a physical lease. */
export class BodyActionService {
  readonly runtime: BodyExecutionRuntime;
  private readonly authority = new ExecutionAuthority();
  private readonly driver: GameBodyDriver;
  private readonly ownerEpochs = new Map<string, number>();
  private readonly operations = new Map<string, RunningAction>();
  private readonly unsubs: Array<() => void> = [];
  private safetyOwnerEpoch = 1;
  constructor(private readonly deps: {
    game: GameAdapter; nav: NavigationAdapter; registry: IBehaviorRegistry; bus: EventBusV2;
    tasks: TaskRuntime; getWorld(): WorldStateView; isEmbodied(): boolean;
    getGoalState(sessionId: string): GoalAgentStateV1 | null;
  }) {
    this.driver = new GameBodyDriver(deps);
    this.runtime = new BodyExecutionRuntime({driver:this.driver,authority:this.authority});
    for (const task of deps.tasks.list()) if (task.state==='running') this.ownerEpochs.set(task.id,1);
    for (const type of ['task.started','task.resumed','task.paused','task.completed','task.failed','task.cancelled']) {
      this.unsubs.push(deps.bus.on(type,event => {
        const id = (event.payload as {taskId?:string}).taskId;
        if (!id) return;
        this.ownerEpochs.set(id,(this.ownerEpochs.get(id) ?? 0)+1);
        for (const operation of this.operations.values()) {
          if (operation.intent.owner.kind!=='safety' && operation.intent.owner.taskId===id) operation.handle.cancel(type);
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
      isCurrent:()=>this.deps.tasks.isRunning(id) && this.ownerEpochs.get(id)===ownerEpoch});
  }

  /** Only the heartbeat's registered reflex/defense producers receive this method. */
  async executeSafety(request: ActionRequest, policyId: string): Promise<BodyActionResult> {
    if (request.type==='say') return this.speech(request);
    if (request.type==='stop' || request.type==='stop_follow') return this.rejected(request,'safety_stop_requires_owned_operation');
    const ownerEpoch = this.safetyOwnerEpoch;
    return this.execute(request,{owner:{kind:'safety',policyId,ownerEpoch},operationId:`safety-action:${randomUUID()}`,
      scope:this.worldScope(),isCurrent:()=>this.safetyOwnerEpoch===ownerEpoch && tuning().defense.automaticEnabled});
  }

  async executeGoal(request: ActionRequest, input: GoalBodyRequest): Promise<BodyActionResult> {
    const {state,taskId,signal} = input;
    const owner: ExecutionOwner = {kind:'goal',taskId,sessionId:state.sessionId,epoch:state.epoch,planRevision:state.plan.revision};
    const isCurrent = () => {
      const live = this.deps.getGoalState(state.sessionId);
      return !signal.aborted && this.deps.tasks.isRunning(taskId) && !!live
        && live.epoch===owner.epoch && live.plan.revision===owner.planRevision && live.phase==='running';
    };
    return this.execute(request,{owner,operationId:input.operationId,scope:state.rootGoal?.schema==='mineclaw.goal/v2'
      ? state.rootGoal.scope : this.worldScope(),isCurrent,signal});
  }

  cancelAll(reason: string): void {
    this.safetyOwnerEpoch++;
    for (const operation of this.operations.values()) operation.handle.cancel(reason);
  }

  async drainAll(reason:string):Promise<void> {
    const pending=[...this.operations.values()];
    this.cancelAll(reason);
    const receipts=await Promise.all(pending.map(value=>value.handle.result));
    if(receipts.some(value=>!value.stop)) throw new Error('body_stop_unconfirmed');
  }

  async drainTask(taskId: string, reason: string): Promise<void> {
    const matching = [...this.operations.values()].filter(value=>value.intent.owner.kind!=='safety' && value.intent.owner.taskId===taskId);
    for (const value of matching) value.handle.cancel(reason);
    const receipts = await Promise.all(matching.map(value=>value.handle.result));
    if (receipts.some(value=>!value.stop)) throw new Error('body_stop_unconfirmed');
  }

  close(): void { this.cancelAll('runtime_closed'); for (const unsubscribe of this.unsubs) unsubscribe(); }

  private async execute(request: ActionRequest, policy: {
    owner: ExecutionOwner; operationId: string; scope: BoundGoalScope; isCurrent(): boolean; signal?: AbortSignal;
  }): Promise<BodyActionResult> {
    const start = Date.now();
    try {
      if (!this.deps.isEmbodied()) throw new Error('game_body_unavailable');
      const dimension=policy.scope.dimension;
      const intent: OperationIntent = {
        operationId:policy.operationId,owner:policy.owner,command:actionCommand(request, ownerContribution(request)),scope:policy.scope,
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
        if (this.runtime.inspect(intent.operationId)?.state==='settled') this.operations.delete(intent.operationId);
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

/**
 * Explicit one-shot legacy mapping (kernel design §5.10): until the builtin
 * plugins take over (completion of -004), body commands carry a real
 * ContributionRef under the `mineclaw.legacy-builtin` namespace. The deletion
 * gate for -004 requires zero production references to this namespace.
 */
const LEGACY_BUILTIN = { pluginId: 'mineclaw.legacy-builtin', pluginVersion: '1.0.0' } as const;

function ownerContribution(request: ActionRequest): ContributionRef {
  const id = request.type === 'invoke_behavior'
    ? `behavior:${String(request.target?.behavior ?? '')}`
    : `atomic:${request.type}`;
  return {
    pluginId: LEGACY_BUILTIN.pluginId,
    pluginVersion: LEGACY_BUILTIN.pluginVersion,
    contributionId: id,
    contributionVersion: '1.0.0',
  };
}
