export const entryNodes = [
  { title: '玩家', caption: '自然语言目标与反馈', aspect: 'cognition' },
  { title: 'WebUI', caption: '控制台、状态与轨迹', aspect: 'evidence' },
  { title: 'Minecraft Chat', caption: '世界内对话入口', aspect: 'cognition' },
];

export const coreNodes = [
  {
    id: 'hub',
    index: '01',
    title: 'Hub API / Socket',
    subtitle: '统一入口与实时分发',
    detail: '接收 WebUI 与游戏聊天事件，把状态、任务和轨迹持续推送给界面。',
    aspect: 'evidence',
    source: 'src/index.ts',
  },
  {
    id: 'brain',
    index: '02',
    title: 'MainBrain',
    subtitle: '人格、聊天与委派',
    detail: '负责伙伴人格和对话判断；需要操作世界时只委派给 GoalAgentPort，不直接执行游戏动作。',
    aspect: 'cognition',
    source: 'src/bot/v2/decision/mainBrain.ts',
  },
  {
    id: 'port',
    index: '03',
    title: 'GoalAgentPort',
    subtitle: '唯一游戏查询 / 动作边界',
    detail: '把高层意图收敛为受约束的 GoalAgent 会话，是 MainBrain 通往真实世界的唯一执行接口。',
    aspect: 'execution',
    source: 'src/bot/v2/decision/goalAgentPort/goalAgentPort.ts',
  },
];

export const roundSteps = [
  { index: 'A', title: 'Model', caption: '读取目标与会话上下文', aspect: 'cognition' },
  { index: 'B', title: 'Tool Call', caption: '选择并提交工具调用', aspect: 'execution' },
  { index: 'C', title: 'Tool Result', caption: '接收机器可验证结果', aspect: 'execution' },
  { index: 'D', title: 'Session Event Log', caption: '追加事件，再进入下一轮', aspect: 'evidence' },
];

export const gateItems = [
  '权限', 'Schema', '预算', 'Deadline', 'Checkpoint / CAS', '幂等', '机器验真',
];

export const executionNodes = [
  { title: 'Production Execution Port', caption: '候选动作编排', aspect: 'execution' },
  { title: 'TaskRuntime', caption: '任务生命周期与状态', aspect: 'execution' },
  { title: 'Strategy / Behavior / Atomic', caption: '策略、行为与原子能力', aspect: 'execution' },
  { title: 'GameAdapter / Mineflayer', caption: '协议与世界动作适配', aspect: 'execution' },
  { title: 'Minecraft World', caption: '最终事实来源', aspect: 'evidence' },
];

export const supportPlanes = [
  { title: 'Perception', caption: '世界快照与感知管线', aspect: 'cognition', source: 'src/bot/v2/perception/pipeline.ts' },
  { title: 'Memory / Skill / Knowledge', caption: '检索、经验与能力定义', aspect: 'cognition', source: 'src/bot/v2/memory/retrieval/memorySystem.ts' },
  { title: 'EventBus', caption: '模块间事件边界', aspect: 'evidence', source: 'src/bot/v2/infra/eventBus.ts' },
  { title: 'LLM Trace', caption: '调用输入、输出与账本', aspect: 'evidence', source: 'src/bot/v2/infra/llmTrace/' },
  { title: 'WebUI', caption: '运行状态与人工检查', aspect: 'evidence', source: 'web/src/App.vue' },
];

export const sourceLedger = [
  ['组合根', 'src/bot/v2/v2Runtime.ts'],
  ['MainBrain', 'src/bot/v2/decision/mainBrain.ts'],
  ['执行边界', 'src/bot/v2/decision/goalAgentPort/goalAgentPort.ts'],
  ['连续循环', 'src/bot/v2/task/goalAgent/goalAgentRoundLoop.ts'],
  ['生产端口', 'src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.ts'],
  ['任务运行时', 'src/bot/v2/task/taskRuntime.ts'],
  ['游戏抽象', 'src/bot/v2/adapter/GameAdapter.ts'],
  ['Mineflayer 适配', 'src/bot/v2/mineflayer/MineflayerGameAdapter.ts'],
];
