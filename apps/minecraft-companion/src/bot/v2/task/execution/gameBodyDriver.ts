import type { EventBusV2 } from '../../infra/eventBus.js';
import type { OperationCommand, OperationIdentity } from '../contracts/bodyOperation.js';
import type { BodyOperationDriver, BoundOperationExecutor } from './ports/controlledExecution.js';
import { atomicRequest } from './actionCommand.js';
import { failureDetail, failureFromLegacy } from './failureEnvelope.js';
import type { ActionRequest } from '../../types.js';
import type { ActionPrepareResult } from './actionPreparer.js';
import type { GenerationAtomicEntryPort, GenerationBehaviorResolverPort } from './generationResolversPorts.js';
import { createScopedHostContext } from '../../plugin-sdk/contracts/scopedContext.js';
import { atomicExecutionContextAdapter } from './generationResolversPorts.js';
import type { PluginBehaviorInstance } from '../../plugin-sdk/contracts/execution.js';
import type { PluginGoalLease } from '../../plugin-sdk/identity.js';

/**
 * Registered programs consume one body lease. They cannot acquire another physical owner.
 * P3-4: existence is validated against the pinned generation; execution keeps the
 * bound-device path (only BodyExecutionRuntime owns body effects — kernel design §5.1).
 */
export class GameBodyDriver implements BodyOperationDriver {
  constructor(private readonly deps: {
    bus: EventBusV2;
    /** P3-4 · 原子存在性只经固定 snapshot 校验（绝不回退 live registry 或自建默认目录）。 */
    atomicResolver: GenerationAtomicEntryPort;
    /** Behavior factories are resolved only from the command's pinned generation. */
    behaviorResolver: GenerationBehaviorResolverPort;
    hostApiVersion: string;
  }) {}
  accepts(command: OperationCommand): boolean {
    if (!command.ref.contribution?.contributionId) return false;
    if (command.ref.id.startsWith('behavior:')) {
      return this.deps.behaviorResolver.resolve(command.snapshot, command.ref.contribution).status === 'resolved';
    }
    if (!command.ref.id.startsWith('atomic:')) return false;
    const id = command.ref.id.slice(7);
    if (['invoke_behavior','stop','stop_follow'].includes(id)) return false;
    // Acceptor validates existence in the pinned generation (fail-closed; never a default registry).
    return this.deps.atomicResolver.resolve(command.snapshot, id).status === 'resolved';
  }

  resources(command: OperationCommand): readonly string[] {
    if (!this.accepts(command)) throw new Error(`body_command_not_registered:${command.ref.id}`);
    // Walking, hands, view direction and inventory are coupled by the Minecraft protocol.
    // Independent resources can be added only by a driver with an actual independent device.
    return ['minecraft:body'];
  }

  bind(_identity: OperationIdentity, command: OperationCommand): BoundOperationExecutor {
    this.resources(command);
    let behavior: PluginBehaviorInstance | undefined;
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    let stopped = false;
    return {
      run: async context => {
        context.assertCurrent('driver-bind');
        if (stopped) throw new Error('driver_binding_stopped');
        if (command.ref.id.startsWith('behavior:')) {
          const resolved = this.deps.behaviorResolver.resolve(command.snapshot, command.ref.contribution);
          if (resolved.status === 'in_doubt') {
            return { ok: false, failure: failureFromLegacy(resolved.reason, { origin: 'behavior', stage: 'preparing' }) };
          }
          const lease = behaviorLease(context);
          behavior = resolved.value.factory.create(lease, createScopedHostContext(
            { version: this.deps.hostApiVersion, buildId: command.snapshot.buildId },
            { pluginId: resolved.value.contribution.pluginId, pluginVersion: resolved.value.contribution.pluginVersion },
          ));
          this.deps.bus.publish('behavior.start', 'info', {
            behaviorId: resolved.value.factory.id,
            contribution: resolved.value.contribution,
            operationId: context.operationId,
          });
          try {
            const result = behavior.kind === 'sequence'
              ? await runSequenceBehavior(behavior.compile({ goal: lease, params: command.args, facts: [] }), context, this.deps.atomicResolver)
              : await behavior.run({
                  goal: lease,
                  signal: context.signal,
                  params: command.args,
                  facts: [],
                  submitBody: request => submitPluginAtomic(request, context, this.deps.atomicResolver),
                  publish: (type, level, payload) => this.deps.bus.publish(type, level === 'info' ? 'info' : 'recoverable', payload),
                });
            context.assertCurrent('plugin_behavior_result');
            this.deps.bus.publish(result.ok ? 'behavior.success' : 'behavior.fail', result.ok ? 'info' : 'recoverable', {
              behaviorId: resolved.value.factory.id,
              contribution: resolved.value.contribution,
              operationId: context.operationId,
              ...(result.details ?? {}),
            });
            return { ok: result.ok, ...(result.details ? { details: result.details } : {}),
              ...(!result.ok ? { failure: failureFromLegacy(result.error ?? (result.cancelled ? 'behavior_cancelled' : 'behavior_failed'), { origin: 'behavior', stage: 'executing' }) } : {}) };
          } finally {
            await behavior.close();
          }
        }
        const atomicId = command.ref.id.slice(7);
        const entry = this.deps.atomicResolver.resolve(command.snapshot, atomicId);
        if (entry.status === 'in_doubt') {
          return { ok: false, failure: failureFromLegacy(entry.reason, { origin: 'atomic', stage: 'preparing' }) };
        }
        // 参数合同与执行器来自同一个固定 Generation entry。验证、执行、审计
        // 不得分别查询不同目录，也不得绕过插件执行器回到框架内置 switch。
        const validate = entry.value.contract
          ? (args: Record<string, unknown>): ActionPrepareResult => {
              const prepared = entry.value.contract!.prepare?.(args);
              if (prepared && 'invalid' in prepared) {
                return { kind: 'invalid', failure: failureFromLegacy(prepared.invalid.message, { origin: 'atomic', stage: 'preparing' }) };
              }
              const target = (prepared && 'prepared' in prepared ? prepared.prepared : args) as Record<string, unknown>;
              return {
                kind: 'ready',
                action: { proposal: { action: atomicId, source: 'registered_behavior', args }, target, derivedFields: prepared && 'derivedFields' in prepared && prepared.derivedFields ? [...prepared.derivedFields] : [], contractVersion: 1 },
                request: {
                  id: context.stepId, source: 'registered_behavior',
                  taskId: context.owner.taskId,
                  type: atomicId as ActionRequest['type'], priority: 35, interrupt_level: 'soft', resource: [],
                  target: target as unknown as ActionRequest['target'],
                  preconditions: [], timeout_ms: 30_000,
                },
              };
            }
          : undefined;
        const request = atomicRequest(command,context,validate);
        context.assertCurrent('plugin_atomic_before_execute');
        const result = await entry.value.executor.execute(
          { request: request as unknown as Readonly<Record<string, unknown>>, source: request.source },
          atomicExecutionContextAdapter(context, cleanup => { cleanups.push(cleanup); }),
          context.signal,
        );
        context.assertCurrent('plugin_atomic_after_execute');
        const ok = result.ok !== false;
        return {
          ok,
          ...(ok ? { details: result } : {
            failure: failureFromLegacy(String(result.error ?? 'plugin_atomic_failed')),
          }),
        };
      },
      stop: async reason => {
        stopped = true;
        const results = await Promise.allSettled([
          behavior?.halt(), behavior?.close(),
          ...cleanups.reverse().map(cleanup => cleanup(reason)),
        ]);
        const errors = results.flatMap(value => value.status==='rejected' ? [value.reason] : []);
        if (errors.length) throw new AggregateError(errors,'body_driver_cleanup_failed');
      },
    };
  }
}

async function runSequenceBehavior(
  compilation: import('../../plugin-sdk/contracts/execution.js').PluginBehaviorCompilation,
  context: import('./ports/controlledExecution.js').ControlledExecutionContext,
  atomicResolver: GenerationAtomicEntryPort,
): Promise<import('../../plugin-sdk/contracts/execution.js').PluginBehaviorResult> {
  if (!compilation.ok) return { ok: false, cancelled: false, error: compilation.error };
  for (const step of compilation.steps) {
    context.assertCurrent('plugin_sequence_before_child');
    const receipt = await submitPluginAtomic({ atomicId: step.atomicId, args: step.args }, context, atomicResolver);
    if ((receipt as { ok?: boolean }).ok === false) {
      return { ok: false, cancelled: context.signal.aborted, error: String((receipt as { error?: unknown }).error ?? 'behavior_child_failed') };
    }
    context.assertCurrent('plugin_sequence_after_child');
  }
  return { ok: true, cancelled: false };
}

function behaviorLease(context: import('./ports/controlledExecution.js').ControlledExecutionContext): PluginGoalLease {
  const owner = context.owner;
  return Object.freeze({
    goalId: owner.kind === 'goal' ? owner.sessionId : owner.taskId,
    sessionId: owner.kind === 'goal' ? owner.sessionId : context.operationId,
    snapshot: context.command.snapshot,
    ownerEpoch: owner.kind === 'goal' ? owner.epoch : owner.ownerEpoch,
    operationEpoch: context.operationEpoch,
    aborted: context.signal.aborted,
  });
}

async function submitPluginAtomic(
  request: Readonly<Record<string, unknown>>,
  context: import('./ports/controlledExecution.js').ControlledExecutionContext,
  resolver: GenerationAtomicEntryPort,
): Promise<Readonly<Record<string, unknown>>> {
  context.assertCurrent('plugin_behavior_before_child');
  const atomicId = typeof request.atomicId === 'string' ? request.atomicId.trim() : '';
  const args = request.args;
  if (!atomicId || !args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'invalid_plugin_body_request' };
  }
  const entry = resolver.resolve(context.command.snapshot, atomicId);
  if (entry.status === 'in_doubt') return { ok: false, error: `needs_rebind:${entry.reason}` };
  const outcome = await context.execute({
    ref: { id: `atomic:${atomicId}`, contribution: entry.value.contribution },
    snapshot: context.command.snapshot,
    args: {
      target: args,
      source: `plugin:${context.command.ref.contribution.contributionId}`,
      timeoutMs: Math.max(1, context.deadlineAt - Date.now()),
    },
  });
  context.assertCurrent('plugin_behavior_after_child');
  return { ok: outcome.ok, ...(outcome.failure ? { error: failureDetail(outcome.failure) } : {}), ...(outcome.details ?? {}) };
}
