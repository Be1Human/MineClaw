/**
 * 工具定义 · 资源决策域
 *   resolve_resource · decide_with_policy
 */

import type { ToolDefinition } from '../types.js';
import type { ResourceRequirement } from '../../../task/resourceProvider.js';

export const resourceTools: ToolDefinition[] = [
  {
    name: 'resolve_resource',
    description: '找资源候选，返回 candidates[] 含 satisfaction / partialAmount / estimatedCostSec',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        name: { type: 'string' },
        minDurability: { type: 'number' },
      },
      required: ['kind', 'name'],
    },
    execute(input, ctx) {
      const req = input as unknown as ResourceRequirement;
      const world = ctx.perception.getWorldState();
      if (!world) throw new Error('no_world_state');
      const res = ctx.resolver.resolve(req, world);
      ctx.lastResolution = res;
      return res;
    },
  },
  {
    name: 'decide_with_policy',
    description: '让 policy 看上一次 resolve_resource，返回 auto/ask_master/escalate_llm/no_solution',
    parameters: { type: 'object', properties: {}, required: [] },
    execute(_input, ctx) {
      if (!ctx.lastResolution) throw new Error('no_resolution_to_decide');
      return ctx.policy.decide(ctx.lastResolution);
    },
  },
];
