import type { EventBusV2 } from '../infra/eventBus.js';
import type { ActionRequest, ExecutionResult, WorldStateView } from '../types.js';
import type { ControlledExecutionContext, OperationOutcome } from '../task/execution/ports/controlledExecution.js';
import { actionCommand } from '../task/execution/actionCommand.js';
import { failureDetail, failureFromLegacy } from '../task/execution/failureEnvelope.js';
import type { IBehavior, AdaptiveBehaviorContext } from './types.js';
import { assertBehaviorDefinition } from './behaviorDefinition.js';

/** One-way composition: Behavior -> authorized child operation -> Atomic. */
export class BehaviorRunner {
  constructor(private readonly deps: { getWorld(): WorldStateView; bus: EventBusV2 }) {}

  async run(behavior: IBehavior, context: ControlledExecutionContext): Promise<OperationOutcome> {
    assertBehaviorDefinition(behavior);
    context.assertCurrent('behavior_start');
    const taskParams = context.command.args as Record<string, unknown>;
    const execute = async (request: ActionRequest): Promise<ExecutionResult> => {
      context.assertCurrent('behavior_before_child');
      if (request.type === 'invoke_behavior' || request.type === 'stop' || request.type === 'stop_follow') {
        throw new Error('behavior_child_must_be_atomic');
      }
      const started = Date.now();
      const childContribution = { pluginId: 'mineclaw.legacy-builtin', pluginVersion: '1.0.0', contributionId: `atomic:${request.type}`, contributionVersion: '1.0.0' };
      const result = await context.execute(actionCommand(request, childContribution));
      context.assertCurrent('behavior_after_child');
      return { ok: result.ok, request, durationMs: Date.now() - started,
        ...(result.failure ? { error: failureDetail(result.failure) } : {}) };
    };
    const port: AdaptiveBehaviorContext = {
      taskParams, signal: context.signal,
      getWorld: () => { context.assertCurrent('behavior_observe'); return this.deps.getWorld(); },
      execute, wait: ms => context.wait(ms),
      publish: (type, level, payload) => this.deps.bus.publish(type, level, payload),
    };
    this.deps.bus.publish('behavior.start', 'info', { behaviorId: behavior.id, operationId: context.operationId });
    let result: OperationOutcome;
    if (behavior.kind === 'sequence') {
      const steps = behavior.compile({ world: port.getWorld(), taskParams });
      if (!Array.isArray(steps)) throw new Error('invalid_behavior_sequence');
      result = { ok: true };
      for (const step of steps) {
        const child = await execute(step);
        if (!child.ok) {
          result = { ok: false, failure: failureFromLegacy(child.error, { origin: 'behavior', stage: 'executing' }) };
          break;
        }
      }
    } else {
      const outcome = await behavior.run(port);
      result = { ok: outcome.ok, ...(outcome.details ? { details: outcome.details } : {}),
        ...(!outcome.ok ? { failure: failureFromLegacy(outcome.error, { origin: 'behavior', stage: 'executing' }) } : {}) };
    }
    context.assertCurrent('behavior_result');
    this.deps.bus.publish(result.ok ? 'behavior.success' : 'behavior.fail', result.ok ? 'info' : 'recoverable', {
      behaviorId: behavior.id, operationId: context.operationId, ...(result.details ?? {}),
    });
    return result;
  }
}
