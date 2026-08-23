import type { LLMToolSchema } from '../../cognitive/llm/types.js';
import type { IBehaviorRegistry } from '../../behavior/types.js';

interface PlannerBehaviorContext {
  nodeId: string;
  planGraph: {
    nodes: Array<{
      id: string;
      goal: { taskFamily?: string };
    }>;
  };
}

/**
 * BehaviorRegistry 是可调用复合行为的唯一事实源。
 * 每次构建工具 schema 时重新读取，保证热注册后自动可见。
 */
export function listBehaviorIds(registry: IBehaviorRegistry): string[] {
  return [...new Set(registry.list().map(behavior => behavior.id.trim()).filter(Boolean))].sort();
}

export function behaviorCatalogText(registry: IBehaviorRegistry): string {
  const ids = listBehaviorIds(registry);
  return ids.length > 0 ? ids.join(', ') : '（当前无已注册复合行为）';
}

export function validateBehaviorId(
  registry: IBehaviorRegistry,
  behaviorId: string,
): { ok: true } | { ok: false; error: string; available: string[] } {
  const available = listBehaviorIds(registry);
  if (!behaviorId || !registry.get(behaviorId)) {
    return {
      ok: false,
      error: `behavior_not_found: ${behaviorId || '(empty)'}`,
      available,
    };
  }
  return { ok: true };
}

/**
 * Planner taskFamily 与 Behavior ID 的精确命名契约。
 * 缺少当前 PlanNode 或未注册同名 Behavior 时不猜测，交给既有 slow fallback。
 */
export function resolvePlannerBehaviorId(
  registry: IBehaviorRegistry,
  plannerContext?: PlannerBehaviorContext,
): string | null {
  if (!plannerContext) return null;
  const taskFamily = plannerContext.planGraph.nodes
    .find(node => node.id === plannerContext.nodeId)
    ?.goal.taskFamily?.trim();
  return taskFamily && registry.get(taskFamily) ? taskFamily : null;
}

/**
 * Registered behaviors retain ownership across a bounded Coordinator retry.
 * Only a normal continuation or a retryable physical failure may re-enter the
 * same behavior; prerequisite/contract recovery must fall back to planning.
 */
export function shouldRetryRegisteredBehavior(
  stepKind: 'continued' | 'recovery' | 'terminal' | 'ignored',
  recoveryKind?: string,
): boolean {
  return stepKind === 'continued'
    || (stepKind === 'recovery' && recoveryKind === 'retry');
}

export function buildInvokeBehaviorToolSchema(registry: IBehaviorRegistry): LLMToolSchema | null {
  const ids = listBehaviorIds(registry);
  if (ids.length === 0) return null;
  return {
    type: 'function',
    function: {
      name: 'invoke_behavior',
      description: `调用已注册的 L4 复合行为。behavior 必须使用以下精确 ID：${ids.join(', ')}。params 是该行为的任务参数。`,
      parameters: {
        type: 'object',
        properties: {
          behavior: { type: 'string', enum: ids, description: 'BehaviorRegistry 中的精确 ID' },
          params: { type: 'object' },
        },
        required: ['behavior'],
      },
    },
  };
}
