import type { ActionRequest } from '../../types.js';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { tuning } from '../../infra/tuning.js';
import type { OperationCommand } from '../contracts/bodyOperation.js';
import type { ControlledExecutionContext } from './ports/controlledExecution.js';
import { defaultActionPreparer } from './actionPreparer.js';
import { failureDetail } from './failureEnvelope.js';

/** Convert a registered producer's request into the immutable, code-authorized body command. */
export function actionCommand(request: ActionRequest): OperationCommand {
  if (request.type === 'invoke_behavior') {
    const id = request.target?.behavior;
    if (!id) throw new Error('behavior_id_required');
    return jsonSnapshot({ ref: { id: `behavior:${id}`, version: '1' }, args: request.target?.behaviorParams ?? {} });
  }
  if (request.type === 'stop' || request.type === 'stop_follow') throw new Error('stop_is_activity_control');
  return jsonSnapshot({ ref: { id: `atomic:${request.type}`, version: '1' }, args: {
    target: request.target ?? {}, source: request.source,
    timeoutMs: request.timeout_ms ?? tuning().controlledExecution.operationTimeoutMs,
  } });
}

/** Owner, resource claims and execution identity are never inherited from a behavior's child metadata. */
export function atomicRequest(command: OperationCommand, context: ControlledExecutionContext): ActionRequest {
  if (command.ref.version !== '1' || !command.ref.id.startsWith('atomic:')) throw new Error('invalid_atomic_command');
  const type = command.ref.id.slice('atomic:'.length);
  if (type === 'invoke_behavior' || type === 'stop' || type === 'stop_follow') throw new Error('not_an_atomic_operation');
  const target = command.args.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('invalid_atomic_target');
  const prepared = defaultActionPreparer.prepare({ action: type, source: 'registered_behavior', args: target as Record<string, unknown> }, {
    execId: context.stepId, ...(context.owner.kind === 'safety' ? {} : { taskId: context.owner.taskId }),
  });
  if (prepared.kind === 'invalid') throw new Error(failureDetail(prepared.failure));
  const duration = command.args.timeoutMs;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('invalid_atomic_timeout');
  return { ...prepared.request,
    source: typeof command.args.source === 'string' ? command.args.source : command.ref.id,
    timeout_ms: Math.min(duration, Math.max(0, context.deadlineAt - Date.now())),
  };
}
