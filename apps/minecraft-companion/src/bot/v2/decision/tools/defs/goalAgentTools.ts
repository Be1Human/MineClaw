import type { ToolDefinition } from '../types.js';

export const goalAgentTools: ToolDefinition[] = [{
  name: 'submit_goal_request',
  description: '这是你的内部执行循环，也是唯一游戏能力入口；Planner、Actor、Critic、Recovery 等节点共享同一上下文，仍然是你在做。可委托完整 task，也可先 query 游戏事实；禁止在 MainBrain 拆原子动作。准备型 query 必须标记 prepare_task，确保原任务能续接。',
  parameters: {
    type: 'object',
    properties: {
      requestText: { type: 'string', description: '完整游戏任务；玩家任务尽量保留原始意图，自主任务填写自然语言高层目标' },
      requestKind: { type: 'string', enum: ['task', 'query', 'cancel'] },
      queryPurpose: { type: 'string', enum: ['answer_player', 'prepare_task'], description: '仅 query 使用：直接回答玩家，或为当前任务准备事实' },
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
    if (requestKind !== 'task' && requestKind !== 'query' && requestKind !== 'cancel') {
      throw new Error('invalid_goal_request:requestKind');
    }
    const receipt = ctx.goalAgentPort.request({
      requestText,
      requestKind,
      queryPurpose: input.queryPurpose === 'prepare_task' ? 'prepare_task' : 'answer_player',
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
