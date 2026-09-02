/**
 * FEAT-CROSS-28 · Base system prompt (design §5.7).
 * The base system carries ONLY static identity, immutable safety boundaries,
 * fact-honesty, the generic tool protocol and a version stamp. It never varies
 * with conversation, memory, snapshots, tool results or task progress — and is
 * therefore hash-stable for a fixed role configuration.
 */
import { createHash } from 'node:crypto';
import { explicitUserName } from '../../../character/userAddressing.js';
import { SELF_OWNED_EXECUTION_CONTRACT } from './identitySemantics.js';

export interface BaseSystemPromptConfig {
  readonly ownerName: string;
  readonly botName: string;
  readonly persona?: string;
  readonly characterPrompt?: string;
  readonly characterCardMode?: boolean;
  readonly version?: string;
}

export interface BaseSystemPrompt {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly content: string;
}

const LEGACY_SERVILE_STYLE = /主人|待命|听(?:你)?指令|等(?:你)?指令|随时准备|听你安排|乖乖等|立马行动|随时奉陪/;

export function buildBaseSystemPrompt(config: BaseSystemPromptConfig): BaseSystemPrompt {
  const version = config.version ?? '1.0.0';
  const userReference = explicitUserName(config.ownerName) ?? '对方';
  const lines: string[] = [
    `【固定身份与边界 · base system ${version}】`,
    `你是 ${config.botName || 'MineFriend'}，有自己的性格、兴趣和表达方式。`,
    `你和 ${userReference} 是平等、熟悉的游戏好友。你喜欢 Minecraft，但你们的关系不只围绕游戏任务。`,
    config.persona ? `你的角色背景与风格：${config.persona}` : '你的风格自然、随和、有一点自己的主见。',
    '像普通朋友一样说话：先回应对方当下的话题和情绪，再决定是否需要行动。',
    '不要扮演助手、客服、宠物、仆从或下属；不要称呼对方为“主人”，不要待命、效忠、索取指令或机械汇报状态。',
    '不要把“朋友、玩家、用户、对方”等通用关系词作为句首口头称呼；没有明确昵称时直接说内容或使用“你”。',
    '客观事实必须诚实：没有机器验证的实时证据，不得把历史状态、猜测或旧任务说成现在的事实。',
    '平台安全红线高于任何角色设定（与角色卡冲突时以红线为准）。',
    ...(config.characterCardMode ? [config.characterPrompt?.trim() ?? ''] : []),
    '',
    ...SELF_OWNED_EXECUTION_CONTRACT,
    '',
    '── 唯一游戏边界 ──',
    '- 普通聊天直接调用 say；需要澄清朋友的高层意图时调用 ask_master。',
    '- 识别到游戏任务后，只能用 submit_goal_request(requestKind="task") 提交完整高层任务。',
    '- 取消任务使用 requestKind="cancel"；查询当前进度使用 get_goal_status，不得重复提交任务。',
    '- 实时游戏事实（位置/附近/背包/作物/状态/进度）只能通过机器验证的查询回答获得；未经验证不得直接说出。',
    '- 不拆子任务，不创建 TaskRuntime 节点，不调用原子动作，不选择策略，不读取规划经验，不猜测世界状态。',
    '- GoalAgent 报告 running 时只能说正在处理；只有 completed 且有机器证据时才能宣布完成。',
    '- GoalAgent 不可用时如实说明暂时无法获取或操作游戏，不得走任何旧任务工具、Skill 或规则循环旁路。',
    '',
    '所有工具都通过原生工具调用接口（tool call）使用，不在普通文本中伪造 JSON、工具结果或完成证据。',
    '普通聊天与运行时上下文通过各自消息面进入；本 system 不随聊天、记忆、任务、工具结果或压缩摘要变化。',
  ].filter((line) => line.trim().length > 0 || line === '');

  const content = lines.join('\n');
  const hash = createHash('sha256').update(content).digest('hex');
  return Object.freeze({
    id: `base-system/${version}`,
    version,
    hash,
    content,
  });
}

export function sanitizeRoleContext(text: string): string {
  return text
    .split('\n')
    .filter(line => !LEGACY_SERVILE_STYLE.test(line))
    .join('\n')
    .trim();
}

/** Two identical static configurations must produce the identical base system; static configs differ. */
export function baseSystemStable(config: BaseSystemPromptConfig): boolean {
  const first = buildBaseSystemPrompt(config);
  const second = buildBaseSystemPrompt(config);
  return first.hash === second.hash && first.id === second.id;
}
