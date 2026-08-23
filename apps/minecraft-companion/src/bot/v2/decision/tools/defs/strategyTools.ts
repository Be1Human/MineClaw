/**
 * L7 · strategyTools —— 主人主权管理固化策略（FEAT-CROSS-07 R9）
 *
 * 主人一句"别再用教训某人那套"/"把那个删了" → MainAgent 调本工具 →
 *   StrategyStore.ownerVerdict('rejected'，> 自动评分) / remove。主人否决永高于自动评分。
 */

import type { ToolDefinition } from '../types.js';

export const strategyTools: ToolDefinition[] = [
  {
    name: 'manage_strategy',
    description: '管理自己学会的固化技能(strategy)。朋友想查看、禁用、删除或认可某个策略时调用。action: list(列出) | disable(禁用·永不再用) | approve(认可为可信) | delete(删除)。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | disable | approve | delete' },
        strategyId: { type: 'string', description: 'disable/approve/delete 时的策略 id（从 list 拿）' },
      },
      required: ['action'],
    },
    execute(input, ctx) {
      if (!ctx.strategyStore) {
        return { ok: false, result: { error: '固化技能系统未启用' } };
      }
      const action = String((input as { action?: unknown }).action ?? '').trim();
      const id = typeof (input as { strategyId?: unknown }).strategyId === 'string' ? (input as { strategyId: string }).strategyId : '';
      if (action === 'list') {
        const items = ctx.strategyStore.list().map(s => ({ id: s.id, name: s.name, state: s.lifecycle.state, confidence: Math.round(s.lifecycle.confidence * 100) / 100 }));
        return { ok: true, result: { count: items.length, strategies: items } };
      }
      if (!id) return { ok: false, result: { error: `action=${action} 需要 strategyId` } };
      if (action === 'disable') { ctx.strategyStore.ownerVerdict(id, 'rejected'); return { ok: true, result: { message: `已禁用 ${id}，以后不再用` } }; }
      if (action === 'approve') { ctx.strategyStore.ownerVerdict(id, 'approved'); return { ok: true, result: { message: `已认可 ${id} 为可信` } }; }
      if (action === 'delete') { ctx.strategyStore.remove(id); return { ok: true, result: { message: `已删除 ${id}` } }; }
      return { ok: false, result: { error: `未知 action: ${action}` } };
    },
  },
];
