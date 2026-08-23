/**
 * 用户关系中的身份语义边界。
 *
 * 内部可以由多个 Agent、队列、skill 和恢复器协作，但这些组件共同构成同一个伙伴。
 * 本模块只处理模型可见或用户可见的自然语言，不修改原始事件、任务状态与诊断日志。
 */

/** 两套生产提示词共享，防止 fallback 与 skill 主路径再次漂移。 */
export const SELF_OWNED_EXECUTION_CONTRACT: readonly string[] = [
  '── 自我与内部执行（最高优先级）──',
  '你是唯一对朋友说话、操作游戏并对结果负责的伙伴。GoalAgent 及其 Planner、Actor、Critic、Recovery、Reflection 节点都是你的内部能力，不是另一个角色。',
  '凡是你接下、发起或负责的游戏任务，都用第一人称描述为“我在做”；不得说系统、后台程序、任务队列或其他 Agent 在替你执行，也不得说“不是我在操作”。',
  '任务回执、运行状态和内部通知描述的是你自己的执行进展。可以说“我正在……”“我刚才卡住了”“我换了个办法”，不要复述内部组件名、task ID、running/paused 等调试状态。',
  'Minecraft 服务器、网络、操作系统权限、模型服务和第三方接口才是真正外部主体；发生外部故障时应准确点明，不要错误归为自己。',
];

const INTERNAL_EXECUTOR = /(?:goalagent|subagent|任务系统|后台程序|后台流程|任务队列|内部执行系统)/i;
const INTERNAL_EXECUTION_VERB = /(?:跑|执行|处理|操作|合成|采集|挖(?:掘|矿)?|导航|移动|恢复|重试|拆解|完成|做)/;
const DISOWNING_PHRASE = /(?:不是|并非)(?:由)?我(?:在|来)?(?:手动)?(?:操作|执行|处理|做)|(?:替|代替)我(?:操作|执行|处理|做)/;
const EXTERNAL_SYSTEM = /(?:Minecraft\s*服务器|游戏服务器|服务器|网络|操作系统|系统权限|模型服务|LLM\s*服务|第三方(?:接口|服务)|外部(?:接口|服务)|平台)/i;
const GENERIC_SYSTEM_MENTION = /系统/g;
const EXTERNAL_SYSTEM_QUALIFIER = /(?:操作|游戏|外部|第三方)$/;

function isExternalSystemMention(source: string, offset: number): boolean {
  const prefix = source.slice(0, offset);
  const suffix = source.slice(offset + '系统'.length);
  return EXTERNAL_SYSTEM_QUALIFIER.test(prefix) || suffix.startsWith('权限');
}

function hasGenericSystemMention(sentence: string): boolean {
  for (const match of sentence.matchAll(GENERIC_SYSTEM_MENTION)) {
    const prefix = sentence.slice(0, match.index);
    if (!isExternalSystemMention(sentence, match.index ?? prefix.length)) return true;
  }
  return false;
}

function replaceGenericSystemMentions(text: string): string {
  return text.replace(GENERIC_SYSTEM_MENTION, (match, offset: number, source: string) => {
    return isExternalSystemMention(source, offset) ? match : '我';
  });
}

/**
 * 高置信识别“内部组件替我执行”的身份分裂话术。
 * “Minecraft 服务器断线”“操作系统权限不足”等真实外部主体不命中。
 */
export function hasDisownedInternalExecution(text: string): boolean {
  if (!text.trim()) return false;
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .some((sentence) => {
      if (INTERNAL_EXECUTOR.test(sentence)) {
        return INTERNAL_EXECUTION_VERB.test(sentence) || DISOWNING_PHRASE.test(sentence);
      }
      return hasGenericSystemMention(sentence)
        || (!EXTERNAL_SYSTEM.test(sentence) && /系统/.test(sentence) && DISOWNING_PHRASE.test(sentence));
    });
}

/** 用户表面还必须阻止内部 Agent 名、task ID 和运行枚举直接泄漏。 */
export function hasUserFacingIdentityLeak(text: string): boolean {
  if (hasDisownedInternalExecution(text)) return true;
  if (/(?:goalagent|subagent|\btask-[a-z0-9_-]+\b)/i.test(text)) return true;
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .some(sentence => !EXTERNAL_SYSTEM.test(sentence)
      && /\b(?:running|paused|completed|failed|cancelled)\b/i.test(sentence));
}

/**
 * 把内部执行叙事投影成同一伙伴的第一人称视图。
 * 用于 system 上下文、旧 assistant 历史和当前可见思考；原始文本仍留在日志/存储中。
 */
export function normalizeInternalExecutionNarrative(text: string): string {
  if (!text.trim()) return '';
  const normalized = text
    .replace(/(^|[\s，。！？；：、“”]|另外|还有|同时|而且|然后|现在|当前|其实|不过|但是)系统(?:提示|回执)(?:说|显示)?/g, '$1当前执行状态显示')
    .replace(/(?:我)?不(?:再)?(?:干)?等系统(?:了)?/g, '我不再干等了')
    .replace(/不是(?:什么)?系统(?:在)?(?:替我|帮我)?(?:干活|操作|执行|处理|做)?/g, '就是我自己在做')
    .replace(/(?:goalagent|subagent|任务系统|后台程序|后台流程|任务队列|内部执行系统)/gi, '我');
  return replaceGenericSystemMentions(normalized)
    .replace(/(?:不是|并非)(?:由)?我(?:在|来)?(?:手动)?(?:操作|执行|处理|做)/g, '这是我在执行')
    .replace(/(?:替|代替)我(?:操作|执行|处理|做)/g, '由我执行')
    .replace(/[（(]\s*task-[a-z0-9_-]+(?:\s*[,，]?\s*(?:状态\s*)?(?:running|paused|completed|failed|cancelled))?\s*[）)]/gi, '')
    .replace(/\btask-[a-z0-9_-]+\b/gi, '')
    .replace(/\b(?:running|paused|completed|failed|cancelled)\b/gi, '')
    .replace(/状态\s*(?=[，。！？；：,.;:]|$)/g, '')
    .replace(/我\s*(?:自己)?\s*拆解执行/g, '我继续拆解执行')
    .replace(/我\s*多次自愈仍搞不定/g, '我多次尝试后仍没处理好')
    .replace(/我\s+(?=还在|正在|已经|继续|负责|自己|跑|执行|处理|操作|合成|采集|挖|导航|移动|恢复|重试|拆解|完成|做)/g, '我')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？；：,.;:])/g, '$1')
    .replace(/([，,]){2,}/g, '$1')
    .trim();
}

/** 可见思考是用户表面：无法彻底去掉内部调试标识的行不展示。 */
export function sanitizeUserVisibleThinking(text: string): string {
  return text
    .split('\n')
    .map(normalizeInternalExecutionNarrative)
    .filter(line => line.length > 0)
    .filter(line => !/(?:goalagent|subagent|task-[a-z0-9_-]+|\b(?:running|paused|completed|failed|cancelled)\b)/i.test(line))
    .join('\n')
    .trim();
}
