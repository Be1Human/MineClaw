/**
 * 工具定义 · 世界感知域
 *   get_world_state · get_inventory · where_am_i
 */

import type { ToolDefinition } from '../types.js';
import { dist } from '../types.js';

export const worldTools: ToolDefinition[] = [
  {
    name: 'get_world_state',
    description: '获取世界状态：self/owner/environment/entities/inventory/activeTasks',
    parameters: { type: 'object', properties: {}, required: [] },
    execute(_input, ctx) {
      const world = ctx.perception.getWorldState();
      // 注入当前任务状态，让 LLM 知道自己在做什么
      const activeTasks = ctx.tasks.list()
        .filter(t => t.state === 'running' || t.state === 'paused')
        .map(t => ({ id: t.id, kind: t.kind, state: t.state, params: t.params }));
      return { ...world, activeTasks };
    },
  },
  {
    name: 'get_inventory',
    description: '获取背包：items[]/held/freeSlots',
    parameters: { type: 'object', properties: {}, required: [] },
    execute(_input, ctx) {
      const w = ctx.perception.getWorldState();
      return w?.inventory ?? null;
    },
  },
  {
    name: 'where_am_i',
    description: '我现在在哪：position/dimension/homeDistance/nearestKnownPlace',
    parameters: { type: 'object', properties: {}, required: [] },
    execute(_input, ctx) {
      const here = ctx.game.getPosition();
      const dimension = ctx.game.getDimension();
      const rounded = { x: Math.round(here.x), y: Math.round(here.y), z: Math.round(here.z) };
      let homeDistance: number | null = null;
      let nearest: { kind: string; name: string | null; distance: number } | null = null;
      if (ctx.memory) {
        const homes = ctx.memory.query('spatial', { kind: 'home' });
        if (homes.length > 0) homeDistance = Math.round(dist(here, homes[0].position));
        const all = ctx.memory.query('spatial');
        for (const e of all) {
          const d = Math.round(dist(here, e.position));
          if (!nearest || d < nearest.distance) {
            nearest = { kind: e.kind, name: (e.meta?.name as string) ?? null, distance: d };
          }
        }
      }
      return { ok: true, position: rounded, dimension, homeDistance, nearestKnownPlace: nearest };
    },
  },
];
