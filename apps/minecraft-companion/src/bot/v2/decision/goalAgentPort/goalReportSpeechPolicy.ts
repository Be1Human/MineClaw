import type { GoalReportV2 } from './contracts.js';

export interface SpeechPolicyVerdict {
  pass: boolean;
  reason?: string;
  hint?: string;
}

const COMPLETION_CLAIM = /(?:已经|已|任务)?(?:完成|搞定|做好|拿到|交付|送到|到达)|(?:done|completed|finished|got it|delivered|arrived)/i;
const SUCCESS_CLAIM = /(?:成功|没问题了|一切正常)|(?:success|succeeded|all good)/i;
const PROCESS_CLAIM = /(?:使用|用了?|用|拿着|挥动).{0,12}(?:剑|斧|镐|弓)|(?:攻击|击打|砍|射击)(?:了|过)|(?:吃了|进食|吃下|喝了|食用)|(?:全程|一直).{0,16}(?:保护|护着|没受伤|没有受伤|存活|活着)|(?:没有|没|未)(?:破坏|碰|挖).{0,12}(?:方块|场地|斗兽场)|(?:方块|场地|斗兽场).{0,12}(?:没有|没|未)(?:破坏|碰|挖)|(?:撤退|拉距|逃跑|回血|恢复了?血量)/i;
const PLANNING_ONLY_CLAIM = /(?:还在|仍在|目前还在)?(?:规划|计划)(?:确认)?阶段|(?:规划|计划)好了?(?:就|再)(?:动手|开始|执行|收割)|还在(?:核对|确认)(?:范围|位置)?/i;
const EXECUTING_CLAIM = /正在(?:执行|收割|挖|采集|拾取|归仓|存放|制作|移动|跟随)|已经开始(?:执行|收割|动手|制作|采集)/i;

/** 将 GoalAgent 的状态机约束落实到玩家可见话术，防止 LLM 把进行中/失败改写成成功。 */
export class GoalReportSpeechPolicy {
  instruction(report: GoalReportV2): string {
    const evidence = report.evidence.length > 0
      ? report.evidence.map(item => `${item.type}:${item.ref}@${item.observedAt}`).join(', ')
      : '无';
    return [
      `玩家可见回复必须与 GoalAgent.status=${report.status} 一致。`,
      `可引用的机器证据：${evidence}。`,
      report.status === 'running'
        ? runningInstruction(report)
        : report.status === 'communication_delayed'
          ? '只能说明暂时无法读取运行状态；不得声称任务仍在正常执行、已经失败或已经完成。'
        : report.status === 'failed'
          ? '只能如实说明失败、阻塞或下一步；禁止声称成功或完成。'
          : report.status === 'need_clarification'
            ? '只询问报告中缺失的信息；不得猜测答案或承诺已执行。'
            : report.status === 'cancelled'
              ? '只能说明已停止；不得声称目标已经完成。'
              : report.evidence.length > 0 && report.evidence.every(item => item.type === 'root_verdict')
                ? '当前只有根终态判据。可以陈述目标终态，但禁止声称使用了何种武器、执行了哪些攻击、吃过食物、没有受伤或没有破坏方块。'
                : '只可依据上述机器证据描述结果，不得补造物品、位置或动作。',
    ].join('\n');
  }

  validate(report: GoalReportV2, text: string): SpeechPolicyVerdict {
    const milestone = report.progress?.milestone;
    if (milestone === 'executing' && PLANNING_ONLY_CLAIM.test(text)) {
      return {
        pass: false,
        reason: '任务已处于 executing，话术却退回 planning',
        hint: `请按执行事实重写：${report.summary}`,
      };
    }
    if (milestone === 'planning' && EXECUTING_CLAIM.test(text)) {
      return {
        pass: false,
        reason: '任务仍处于 planning，话术却声称已开始物理执行',
        hint: `请按规划事实重写：${report.summary}`,
      };
    }
    const claimsTerminalSuccess = COMPLETION_CLAIM.test(text) || SUCCESS_CLAIM.test(text);
    if (['running', 'failed', 'need_clarification', 'cancelled', 'communication_delayed'].includes(report.status) && claimsTerminalSuccess) {
      return {
        pass: false,
        reason: `话术声称成功，但 GoalAgent 状态仍是 ${report.status}`,
        hint: `请按报告原意重写：${report.summary}`,
      };
    }
    if (['completed', 'answered'].includes(report.status) && report.evidence.length === 0 && claimsTerminalSuccess) {
      return {
        pass: false,
        reason: '报告没有机器证据，不能向玩家作确定性成功声明',
        hint: `请只陈述已知事实：${report.summary}`,
      };
    }
    const rootVerdictOnly = report.status === 'completed'
      && report.evidence.length > 0
      && report.evidence.every(item => item.type === 'root_verdict');
    if (rootVerdictOnly && PROCESS_CLAIM.test(text)) {
      return {
        pass: false,
        reason: '回复包含具体执行过程，但报告只有根终态判据，没有对应动作证据',
        hint: `只能陈述已验证终态：${report.summary}`,
      };
    }
    return { pass: true };
  }
}

function runningInstruction(report: GoalReportV2): string {
  if (report.progress?.milestone === 'executing') {
    return '只能说明任务正在物理执行或引用当前执行事实；禁止声称仍在规划、还在核对，或规划好了才动手，也禁止声称完成。';
  }
  if (report.progress?.milestone === 'planning') {
    return '只能说明正在规划或校验；禁止声称已经开始收割、制作、采集等物理执行，也禁止声称完成。';
  }
  return '只能说明已开始、正在进行或当前里程碑；禁止声称完成、到达或交付。';
}
