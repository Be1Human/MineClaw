import type { ConversationEntry } from '../infra/memory.js';
import {
  normalizeInternalExecutionNarrative,
  SELF_OWNED_EXECUTION_CONTRACT,
} from './identitySemantics.js';
import { explicitUserName } from '../../../character/userAddressing.js';

export interface SystemPromptParams {
  ownerName: string;
  botName: string;
  persona?: string;
  characterPrompt?: string;
  characterCardMode?: boolean;
  conversationHistory?: ConversationEntry[];
}

const LEGACY_SERVILE_STYLE = /主人|待命|听(?:你)?指令|等(?:你)?指令|随时准备|听你安排|乖乖等|立马行动|随时奉陪/;
const STALE_GAME_STATE = /当前位置|实时位置|坐标|背包|血量|饥饿值?|满血|满食物|状态满格|矿洞里|\(-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\)/;

export function sanitizeRoleContext(text: string, embodied = true): string {
  return text
    .split('\n')
    .filter(line => !LEGACY_SERVILE_STYLE.test(line) && (embodied || !STALE_GAME_STATE.test(line)))
    .join('\n')
    .trim();
}

function buildCharacterContract(p: SystemPromptParams): string[] {
  const userReference = explicitUserName(p.ownerName) ?? '对方';
  if (p.characterCardMode) {
    return [
      '你要稳定扮演下方角色卡定义的角色。角色卡决定身份、关系和世界观；工具只代表当前能力，不改变角色身份。',
      '平台安全与实时事实高于角色设定；没有实时证据时不得把历史状态说成现在。',
      '不要把“朋友、玩家、用户、对方”等通用关系词作为句首口头称呼；没有明确昵称时直接说内容或使用“你”。',
      p.characterPrompt?.trim() ?? '',
    ];
  }
  return [
    `你是 ${p.botName || 'MineFriend'}，有自己的性格、兴趣和表达方式。`,
    `你和 ${userReference} 是平等、熟悉的游戏好友。你喜欢 Minecraft，但你们的关系不只围绕游戏任务。`,
    p.persona ? `你的角色背景与风格：${p.persona}` : '你的风格自然、随和、有一点自己的主见。',
    '像普通朋友一样说话：先回应对方当下的话题和情绪，再决定是否需要行动。',
    '不要扮演助手、客服、宠物、仆从或下属；不要称呼对方为“主人”，不要待命、效忠、索取指令或机械汇报状态。',
    '不要把“朋友、玩家、用户、对方”等通用关系词作为句首口头称呼；没有明确昵称时直接说内容或使用“你”。',
    '普通闲聊不查询或汇报游戏位置、背包、血量、饥饿值和任务；只有对方确实问到游戏状态或要求游戏行动时才使用相关工具。',
    '客观事实必须诚实：没有连接游戏就直说当前没在游戏里，不引用旧任务假装是现在的状态。',
  ];
}

/** MainBrain 对外只维持人格、对话与高层意图；全部游戏认知和行动都经 GoalAgent。 */
export function buildMainBrainSystemPrompt(p: SystemPromptParams): string {
  return [
    ...buildCharacterContract(p),
    '',
    ...SELF_OWNED_EXECUTION_CONTRACT,
    '',
    '你是游戏里的那个真实 AI 玩家：所有朋友发言先由你听见，你维持连续人格、关系、聊天、高层意图和最终表达。',
    'GoalAgent 是你封装好的内部游戏能力，不是另一个对外人格。它内部的 Planner、Actor、Critic、Recovery 和 Reflection 是同一循环里的节点，共享一个会话和上下文。',
    '',
    '── 唯一游戏边界 ──',
    '- 普通聊天直接调用 say；需要澄清朋友的高层意图时调用 ask_master。',
    '- 识别到游戏任务后，只能用 submit_goal_request(requestKind="task") 提交完整高层任务。',
    '- 玩家询问游戏事实时，用 requestKind="query"；查询是原任务准备步骤时设置 queryPurpose="prepare_task"。',
    '- 取消任务使用 requestKind="cancel"；查询当前进度使用 get_goal_status，不得重复提交任务。',
    '- 不拆子任务，不创建 TaskRuntime 节点，不调用原子动作，不选择策略，不读取规划经验，不猜测世界状态。',
    '- GoalAgent 报告 running 时只能说正在处理；只有 completed 且有机器证据时才能宣布完成。',
    '- GoalAgent 不可用时如实说明暂时无法获取或操作游戏，不得走任何旧任务工具、Skill 或规则循环旁路。',
    '',
    '所有工具都通过原生工具调用接口（tool call）使用，不在普通文本中伪造 JSON、工具结果或完成证据。',
    formatConversationHistory(p.conversationHistory),
  ].filter(Boolean).join('\n');
}

export function formatConversationHistory(entries?: ConversationEntry[]): string {
  if (!entries || entries.length === 0) return '';
  const recent = entries.filter(entry => !LEGACY_SERVILE_STYLE.test(entry.content)).slice(-20);
  if (recent.length === 0) return '';
  const lines: string[] = ['── 最近对话记录（供你参考上下文，勿重复回复） ──'];
  const detailThreshold = Math.max(0, recent.length - 10);
  for (let index = 0; index < recent.length; index += 1) {
    const entry = recent[index];
    const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
    const prefix = entry.role === 'owner'
      ? `用户(${time})`
      : `你(${time})`;
    const content = entry.role === 'bot'
      ? normalizeInternalExecutionNarrative(entry.content)
      : entry.content;
    if (!content) continue;
    if (index >= detailThreshold && entry.role === 'bot' && entry.toolCalls?.length) {
      lines.push(`${prefix}: ${content} [调用了: ${entry.toolCalls.map(call=>call.tool).join(', ')}]`);
    } else {
      lines.push(`${prefix}: ${content}`);
    }
  }
  return lines.join('\n');
}
