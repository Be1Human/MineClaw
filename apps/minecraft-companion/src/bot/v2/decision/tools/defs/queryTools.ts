/**
 * 工具定义 · 空间查询域
 *   find_mineral · locate_block · find_chest_with
 */

import type { ToolDefinition } from '../types.js';
import { dist } from '../types.js';
import { resolveBlockId } from '../../../knowledge/dialogueSlots.js';

export const queryTools: ToolDefinition[] = [
  // ── FEAT-L2-02 · 矿物探测查询 ──────────────────────
  {
    name: 'find_mineral',
    description: '查"附近有没有 X 矿"。type ∈ diamond/iron/gold/copper/coal/redstone/lapis/emerald/netherite',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string' } },
      required: ['type'],
    },
    execute(input, ctx) {
      if (!ctx.memory) return { ok: false, error: 'memory_unavailable' };
      const type = input.type as string | undefined;
      if (!type) return { ok: false, error: 'type_required' };
      const allowed = new Set([
        'diamond', 'iron', 'gold', 'copper', 'coal',
        'redstone', 'lapis', 'emerald', 'netherite',
      ]);
      if (!allowed.has(type)) {
        return { ok: false, error: `invalid_mineral_type: ${type}`, allowed: Array.from(allowed) };
      }
      const here = ctx.game.getPosition();
      const all = ctx.memory.query('spatial', { kind: 'resource' });
      const list = all
        .filter(e => (e.meta?.mineralType as string | undefined) === type)
        .map(e => ({
          position: e.position,
          distance: Math.round(dist(here, e.position)),
          blockName: (e.meta?.blockName as string | undefined) ?? null,
          scannedAt: (e.meta?.scannedAt as number | undefined) ?? null,
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 20);  // 防 prompt 爆炸 · 最多回 20 个最近矿点
      return { ok: true, mineral: type, count: list.length, minerals: list };
    },
  },
  // ── FEAT-L7-12 · 地标块按需定位 ─────────────────────
  // "走到金块那里/去那个箱子" → 把块名指代解析成 id，按需 findBlocks 找最近若干个，
  // 返回坐标（含距离/方向）。只【查询返回坐标】，不自动移动——由 MainBrain 决定后续 move_to。
  {
    name: 'locate_block',
    description: '找"附近的 X 方块在哪"——**任意方块名都行**：既包括地标块（金块/羊毛/箱子/工作台/熔炉），也包括自然地形/矿物块（stone 石头、cobblestone、各种 _ore 矿、dirt 泥土、sand 沙子、各种 _log 原木等）。按需扫描返回最近若干个坐标（含距离/方向）。**要挖矿/采集时先用它拿源方块最近坐标**（如挖圆石先 locate_block({name:"stone"})，再对坐标 gather_block）；地标导航同理拿坐标再走。找不到则如实说没看到，不要假装出发。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '块名指代，中英文皆可，如"金块"/"gold block"/"chest"' },
        maxDistance: { type: 'number', description: '搜索半径，默认 32' },
        count: { type: 'number', description: '最多返回几个，默认 3' },
      },
      required: ['name'],
    },
    execute(input, ctx) {
      const name = input.name as string | undefined;
      if (!name) return { ok: false, error: 'name_required' };
      // 解析块 id：同义词命中优先；命中不了但本身像合法 id 就直接拿原名试；再不行才空
      const lower = name.trim().toLowerCase();
      const blockId =
        resolveBlockId(name) ??
        (/^[a-z][a-z0-9_]*$/.test(lower) ? lower : null);
      if (!blockId) {
        return { ok: true, query: name, found: false, blocks: [], hint: 'unresolved_block_name' };
      }
      const maxDistance = typeof input.maxDistance === 'number' ? input.maxDistance : 32;
      const count = typeof input.count === 'number' ? input.count : 3;
      const here = ctx.game.getPosition();
      const positions = ctx.game.findBlocks({ names: [blockId], maxDistance, count });
      const blocks = positions
        .map(p => {
          const dx = p.x - here.x;
          const dz = p.z - here.z;
          // MC 朝向：+x=东 -x=西 +z=南 -z=北
          const dir = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? '东' : '西') : (dz >= 0 ? '南' : '北');
          return { position: p, distance: Math.round(dist(here, p)), dir };
        })
        .sort((a, b) => a.distance - b.distance);
      return { ok: true, query: name, block: blockId, found: blocks.length > 0, count: blocks.length, blocks };
    },
  },
  // ── FEAT-MEM-06 · 箱子内容索引查询 ──────────────────
  {
    name: 'find_chest_with',
    description: '查"哪个箱子里有 X"（基于开箱时记下的内容索引）',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string' } },
      required: ['item'],
    },
    execute(input, ctx) {
      if (!ctx.memory) return { ok: false, error: 'memory_unavailable' };
      const itemName = input.item as string | undefined;
      if (!itemName) return { ok: false, error: 'item_required' };
      const here = ctx.game.getPosition();
      const chests = ctx.memory.findChestsWith(itemName);
      const list = chests
        .map(e => ({
          position: e.position,
          distance: Math.round(dist(here, e.position)),
          items: (e.meta?.items as string[] | undefined) ?? [],
          scannedAt: (e.meta?.itemsScannedAt as number | undefined) ?? e.timestamp,
        }))
        .sort((a, b) => a.distance - b.distance);
      return { ok: true, item: itemName, count: list.length, chests: list };
    },
  },
];
