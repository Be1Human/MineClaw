/**
 * Owner control intents are safety commands, not Minecraft domain planning.
 * Keep this parser small, sentence-initial and shared by the pre-LLM stop
 * barrier and the MainBrain/GoalAgent ingress critic.
 */

const NON_COMMAND_PREFIX = /^(?:如果|假如|要不要|是否|为什么|为啥|怎么|能不能|可以不|我想聊聊|我们聊聊|聊聊|讨论)/;

const GENERIC_CANCEL_PREFIX = /^(?:请|麻烦)?\s*(?:先\s*)?(?:停下来|停下|停止|取消|终止|放弃|别做|不要做)(?:\s*(?:刚才|之前|当前|现在|这个|那个|所有|手头(?:所有)?)?\s*(?:的)?\s*(?:任务|工作|事情|事)?)?(?:了|啦|吧|咯|哦|哦)?(?=$|[\s，,。！!；;：:])/;

// Explicit embodied task verbs only. This intentionally does not match social
// phrases such as “别生气了” or “别跟我讲故事”.
const ACTION_CANCEL_PREFIX = /^(?:请|麻烦)?\s*(?:先\s*)?(?:别|不要|不用)\s*(?:再|继续)?\s*(?:跟(?:着|随)?(?:我|主人)?|挖|采集?|砍|种|走|移动|跑|过来|去|打|攻击|杀|建造?|盖|搭|做|制造?|合成|搬|拿|捡|放|存|烧|钓|喂|驯|守|护|找|丢)(?:下去)?(?:了|啦|吧|咯|哦|哦)?(?=$|[\s，,。！!；;：:])/;

const ENGLISH_CANCEL_PREFIX = /^(?:please\s+)?(?:stop|cancel|abort)(?:\s+(?:the\s+)?(?:current\s+)?(?:task|job|action|following|mining|building))?(?=$|[\s,.!;:])/i;

function cancellationPrefix(message: string): string | null {
  const text = message.trim();
  if (!text || NON_COMMAND_PREFIX.test(text)) return null;
  return text.match(GENERIC_CANCEL_PREFIX)?.[0]
    ?? text.match(ACTION_CANCEL_PREFIX)?.[0]
    ?? text.match(ENGLISH_CANCEL_PREFIX)?.[0]
    ?? null;
}

/** Only sentence-initial, explicit owner imperatives trigger the hard stop. */
export function isTaskCancellationRequest(message: string): boolean {
  return cancellationPrefix(message) !== null;
}

/** Returns the new instruction after a leading cancel command, or null for a pure stop. */
export function stripTaskCancellationPrefix(message: string): string | null {
  const text = message.trim();
  const prefix = cancellationPrefix(text);
  if (!prefix) return text;
  const rest = text
    .slice(prefix.length)
    .replace(/^[\s，,。；;！!：:]+/, '')
    .replace(/^(?:(?:然后|接着|再)\s*)?(?:(?:改成|改为|换成)\s*)?/, '')
    .trim();
  if (!rest || /^(?:吧|一下|先)$/.test(rest)) return null;
  return rest;
}
