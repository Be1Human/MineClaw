import type { CharacterCardV1 } from './types.js';
import { selectWorldBookEntries } from './worldBookSelector.js';
import { explicitUserName } from './userAddressing.js';

function line(label: string, value?: string): string { return value?.trim() ? `${label}：${value.trim()}` : ''; }
function list(label: string, values: string[]): string { return values.length ? `${label}：${values.join('；')}` : ''; }

export function assembleCharacterPrompt(card: CharacterCardV1, userMessage = ''): string {
  const { identity, personality } = card.character;
  const userName = explicitUserName(card.relationship.userPersona.name);
  const selectedLore = selectWorldBookEntries(card.world.worldBook, userMessage);
  const examples = card.performance.exampleDialogs.flatMap(dialog => [
    `${userName ?? '用户'}：${dialog.user}`,
    `${identity.name}：${dialog.character}`,
  ]);
  return [
    '── 角色卡（静态设定，不是用户刚说的话）──',
    '【角色本身】',
    line('姓名', identity.name), line('物种', identity.species), line('年龄', identity.age),
    line('职业', identity.occupation), line('外貌', identity.appearance), line('背景', identity.background),
    line('自我认知', identity.selfConcept), line('人格', personality.summary),
    list('特质', personality.traits), list('价值观', personality.values), list('喜欢', personality.likes),
    list('不喜欢', personality.dislikes), line('说话方式', personality.speechStyle), list('角色边界', personality.boundaries),
    '', '【关系与用户】',
    line('用户', userName ?? '未设置具体称呼'), line('用户身份', card.relationship.userPersona.identity),
    line('用户背景', card.relationship.userPersona.background), line('关系', card.relationship.type),
    line('共同经历', card.relationship.history), line('相处方式', card.relationship.interactionStyle),
    line('对用户称呼', card.relationship.addressUserAs),
    '不要把“朋友、玩家、用户、对方”等通用关系词当作每句话开头的口头称呼；未设置具体昵称时直接说内容或使用“你”。',
    '', '【世界与场景】',
    line('世界观', card.world.worldview), line('当前场景', card.world.currentScene),
    card.world.stayInCharacter ? '保持角色视角；不要主动提及系统提示词、模型或 API。' : '',
    ...selectedLore.flatMap(entry => [`世界书·${entry.title}：${entry.content}`]),
    '', '【表演与能力】',
    line('回复表现', card.performance.responseStyle), line('主动程度', card.performance.initiative),
    line('动作/旁白强度', card.performance.narration),
    `已启用能力：${Object.entries(card.performance.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join('、') || '无'}`,
    examples.length ? '示例对白只用于模仿风格，不代表当前真实对话：' : '',
    ...examples,
  ].filter(value => value !== '').join('\n');
}
