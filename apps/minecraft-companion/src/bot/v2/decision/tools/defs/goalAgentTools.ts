import type { ToolDefinition } from '../types.js';

export const goalAgentTools: ToolDefinition[] = [{
  name: 'submit_goal_request',
  description: '这是你的内部执行循环，也是唯一游戏任务入口；Planner、Actor、Critic、Recovery 等节点共享同一上下文，仍然是你在做。只提交任务/取消；实时事实查询走独立 query 合同（KnowledgeQueryV1）。',
  parameters: {
    type: 'object',
    properties: {
      requestText: { type: 'string', description: '完整游戏任务；玩家任务尽量保留原始意图，自主任务填写自然语言高层目标' },
      requestKind: { type: 'string', enum: ['task', 'cancel'] },
      constraints: { type: 'array', items: { type: 'string' } },
    },
    required: ['requestText', 'requestKind'],
  },
  // 委托后必须等待 GoalAgent 的协议回执再对玩家表态。否则同一轮继续 say
  // 会与同步到达的 need_clarification/completed 报告竞态，产生“先猜答案”的假承诺。
  terminal: 'end_turn',
  execute(input, ctx) {
    if (!ctx.goalAgentPort) throw new Error('goal_agent_unavailable');
    const requestText = typeof input.requestText === 'string' ? input.requestText.trim() : '';
    if (!requestText) throw new Error('invalid_goal_request:requestText 缺失');
    const requestKind = input.requestKind;
    if (requestKind !== 'task' && requestKind !== 'cancel') {
      throw new Error('invalid_goal_request:requestKind');
    }
    const receipt = ctx.goalAgentPort.request({
      requestText,
      requestKind,
      constraints: Array.isArray(input.constraints)
        ? input.constraints.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : undefined,
    });
    return { accepted: receipt.outcome === 'consumed', receipt };
  },
}, {
  name: 'get_goal_status',
  description: '主动获取当前 GoalAgent 任务的新鲜状态快照。任务长时间无回应、玩家追问进度时使用；不会创建或重复提交任务。',
  parameters: { type:'object', properties:{} },
  execute(_input, ctx) {
    if (!ctx.goalAgentPort?.getCurrentStatus) throw new Error('goal_status_unavailable');
    return { snapshot:ctx.goalAgentPort.getCurrentStatus() };
  },
}];
