/**
 * 工具定义 · 记忆域
 *   remember_place · recall_places · recall_my_path · save_memory
 */

import type { ToolDefinition } from '../types.js';
import { dist } from '../types.js';
import type { SpatialEntry } from '../../../infra/memory.js';

export const memoryTools: ToolDefinition[] = [
  // ── FEAT-CROSS-13：统一记忆深度召回 ─────────────────
  {
    name: 'recall_memory',
    description: '当自动注入的记忆不足时，按问题、人物、地点或时间范围深度检索长期记忆与情景经历。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的问题或关键词' },
        entities: { type: 'array', items: { type: 'string' }, description: '相关人物或实体 ID' },
        locations: { type: 'array', items: { type: 'string' }, description: '相关地点或地标' },
        from: { type: 'number', description: '可选，起始 Unix 毫秒时间戳' },
        to: { type: 'number', description: '可选，结束 Unix 毫秒时间戳' },
      },
      required: ['query'],
    },
    execute(input, ctx) {
      if (!ctx.memorySystem) return { ok: false, error: 'memory_unavailable' };
      const query = (input.query as string | undefined)?.trim();
      if (!query) return { ok: false, error: 'invalid_input' };
      const entities = Array.isArray(input.entities)
        ? input.entities.filter((value): value is string => typeof value === 'string')
        : undefined;
      const locations = Array.isArray(input.locations)
        ? input.locations.filter((value): value is string => typeof value === 'string')
        : undefined;
      const from = typeof input.from === 'number' ? input.from : undefined;
      const to = typeof input.to === 'number' ? input.to : undefined;
      const result = ctx.memorySystem.deepRecall({
        query,
        entities,
        locations,
        timeRange: from == null && to == null ? undefined : { from, to },
        includeEvidence: true,
      });
      return { ok: true, result };
    },
  },
  // ── FEAT-MEM-02/03：位置记忆与自我定位 ──────────────
  {
    name: 'remember_place',
    description: '把当前位置记下来。kind ∈ home/chest/resource/landmark',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        name: { type: 'string' },
      },
      required: [],
    },
    execute(input, ctx) {
      if (!ctx.memory) return { ok: false, error: 'memory_unavailable' };
      const kind = (input.kind as SpatialEntry['kind']) ?? 'landmark';
      const name = input.name as string | undefined;
      const pos = ctx.game.getPosition();
      const entry: SpatialEntry = {
        kind,
        position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
        meta: name ? { name } : undefined,
        timestamp: Date.now(),
      };
      ctx.memory.record('spatial', entry);
      return { ok: true, saved: { kind, name: name ?? null, position: entry.position } };
    },
  },
  {
    name: 'recall_places',
    description: '列出记过的地点（按当前距离升序）',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: [],
    },
    execute(input, ctx) {
      if (!ctx.memory) return { ok: false, error: 'memory_unavailable' };
      const kindFilter = input.kind as SpatialEntry['kind'] | undefined;
      const here = ctx.game.getPosition();
      const list = ctx.memory.query('spatial', kindFilter ? { kind: kindFilter } : undefined)
        .map((e) => ({
          kind: e.kind,
          name: (e.meta?.name as string) ?? null,
          position: e.position,
          distance: Math.round(dist(here, e.position)),
        }))
        .sort((a, b) => a.distance - b.distance);
      return { ok: true, places: list };
    },
  },
  // ── FEAT-MEM-05 · 位置轨迹时序查询 ──────────────────
  {
    name: 'recall_my_path',
    description: '位置轨迹查询（minutesAgo=N 单点 / lastMinutes=N 窗口）',
    parameters: {
      type: 'object',
      properties: {
        minutesAgo: { type: 'number' },
        lastMinutes: { type: 'number' },
      },
      required: [],
    },
    execute(input, ctx) {
      if (!ctx.memory) return { ok: false, error: 'memory_unavailable' };
      const minutesAgo = input.minutesAgo as number | undefined;
      const lastMinutes = input.lastMinutes as number | undefined;
      const now = Date.now();

      // 模式 A · 查某个时刻最近的一行（"1 小时前我在哪"）
      if (typeof minutesAgo === 'number') {
        const ts = now - minutesAgo * 60_000;
        const entry = ctx.memory.recallTrajectoryAt(ts);
        if (!entry) return { ok: true, point: null, message: `没有 ${minutesAgo} 分钟前的轨迹` };
        return {
          ok: true,
          point: {
            position: { x: entry.x, y: entry.y, z: entry.z },
            dimension: entry.dimension,
            biome: entry.biome ?? null,
            ageMin: Math.round((now - entry.timestamp) / 60_000),
          },
        };
      }

      // 模式 B · 列出最近 N 分钟内的轨迹点（"我去过哪些地方"）
      const windowMin = typeof lastMinutes === 'number' ? lastMinutes : 60;
      const sinceMs = now - windowMin * 60_000;
      const list = ctx.memory.query('trajectory', { sinceMs });
      // 简化输出 · 防 prompt 爆炸：最多 30 行，必要时下采样
      const stride = Math.max(1, Math.ceil(list.length / 30));
      const sampled = list.filter((_, i) => i % stride === 0).map(t => ({
        position: { x: t.x, y: t.y, z: t.z },
        dimension: t.dimension,
        ageMin: Math.round((now - t.timestamp) / 60_000),
      }));
      return {
        ok: true,
        windowMinutes: windowMin,
        totalPoints: list.length,
        dimensions: ctx.memory.trajectoryDimensions(sinceMs),
        path: sampled,
      };
    },
  },
  // ── FEAT-L7-09 · Hermes 内置记忆 · agent 自主记 ──────
  {
    name: 'save_memory',
    description: '记下关于朋友的长期事实（偏好/习惯/约定）或你自己的笔记。scope=user 记对方、memory 记你自己，默认 user。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话陈述，能独立看懂，如"qxy 喜欢晚上一起挖矿"' },
        scope: { type: 'string', enum: ['user', 'memory'], description: '默认 user' },
      },
      required: ['text'],
    },
    execute(input, ctx) {
      if (!ctx.botMemory) return { ok: false, error: 'memory_unavailable' };
      const text = (input.text as string | undefined)?.trim();
      if (!text) return { ok: false, error: 'invalid_input' };
      const scope = input.scope === 'memory' ? 'memory' : 'user';
      const saved = ctx.botMemory.append(text, scope, ctx.ownerName);
      return { ok: true, saved, scope };
    },
  },
];
