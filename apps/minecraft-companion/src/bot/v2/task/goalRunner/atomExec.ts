/**
 * L6 · atomExec —— GoalAgent Execute 节点/BTInterpreter 共用的原子执行原语
 *
 * 模型：在心跳环**外**异步直驱 `executeAtomic`，挂在一个 per-session【背书注册任务】下（满足
 *   "无注册任务不得占用执行权"铁律 + 任务树=唯一真相）。原子 resolve 后回调 onTerminal 续轮。
 *
 * 为什么不走"每原子建一个 task kind + 策略"：那要给每个原子写策略/critic；而 executeAtomic
 *   本身就是单原子的完整执行（attack=一次挥砍、move_to=走到为止），其 Promise resolve 即"原子做完"，
 *   直接用最省、最准。背书任务只占执行权与可视化，不驱动执行。
 */

import { executeAtomic, type AtomicContext } from '../../atomic/atomics.js';
import type { ActionRequest } from '../../types.js';
import { defaultActionPreparer } from '../execution/actionPreparer.js';
import { failureDetail, failureFromLegacy, type FailureEnvelope } from '../execution/failureEnvelope.js';

export interface AtomDispatchDeps {
  /** 取最新 AtomicContext（worldState 要新鲜） */
  atomicCtx: () => AtomicContext;
  /** 当前 session 的背书任务 id（占执行权）·可空（无则裸跑，仅兜底） */
  backingTaskId: () => string | null;
}

/** 把动作提议经统一合同门编译成 ActionRequest。合同失败会明确抛错，不能产生半合法请求。 */
export function buildAtomicRequest(
  atomic: string,
  args: Record<string, unknown>,
  taskId: string | undefined,
  execId: string,
): ActionRequest {
  const prepared = prepareAtomicRequest(atomic, args, taskId, execId, 'legacy');
  if (prepared.kind === 'invalid') throw new AtomicPreparationError(prepared.failure);
  return prepared.request;
}

export class AtomicPreparationError extends Error {
  constructor(readonly failure: FailureEnvelope) {
    super(failureDetail(failure));
    this.name = 'AtomicPreparationError';
  }
}

export function prepareAtomicRequest(
  atomic: string,
  args: Record<string, unknown>,
  taskId: string | undefined,
  execId: string,
  source: 'slow_llm' | 'fast_strategy' | 'registered_behavior' | 'legacy' = 'legacy',
) {
  return defaultActionPreparer.prepare(
    { source, action: atomic, args: args ?? {} },
    { taskId, execId },
  );
}

/**
 * 派发一个原子（异步直驱），完成后调 onTerminal(execId, ok, detail)。
 * invoke_behavior 也走这里（atomic='invoke_behavior'，args={behavior, behaviorParams}）。
 */
export function dispatchAtomic(
  atomic: string,
  args: Record<string, unknown>,
  execId: string,
  deps: AtomDispatchDeps,
  onTerminal: (execId: string, ok: boolean, detail: string) => void,
): { accepted: true; request: ActionRequest } | { accepted: false; failure: FailureEnvelope } {
  const prepared = prepareAtomicRequest(
    atomic,
    args,
    deps.backingTaskId() ?? undefined,
    execId,
    'slow_llm',
  );
  if (prepared.kind === 'invalid') {
    queueMicrotask(() => onTerminal(execId, false, failureDetail(prepared.failure)));
    return { accepted: false, failure: prepared.failure };
  }
  const req = prepared.request;
  void executeAtomic(req, deps.atomicCtx())
    .then((r) => {
      const failure = defaultActionPreparer.normalize(atomic, r);
      onTerminal(execId, r.ok, failure ? failureDetail(failure) : '');
    })
    .catch((e) => onTerminal(execId, false, failureDetail(failureFromLegacy(
      e instanceof Error ? e.message : String(e),
    ))));
  return { accepted: true, request: req };
}

/** Promise 版单原子执行（BTInterpreter/StrategyExecutor 用 · await 到原子做完） */
export async function runAtomicOnce(
  atomic: string,
  args: Record<string, unknown>,
  execId: string,
  deps: AtomDispatchDeps,
): Promise<{ ok: boolean; detail: string }> {
  const prepared = prepareAtomicRequest(
    atomic,
    args,
    deps.backingTaskId() ?? undefined,
    execId,
    'fast_strategy',
  );
  if (prepared.kind === 'invalid') {
    return { ok: false, detail: failureDetail(prepared.failure) };
  }
  const req = prepared.request;
  try {
    const r = await executeAtomic(req, deps.atomicCtx());
    const failure = defaultActionPreparer.normalize(atomic, r);
    return { ok: r.ok, detail: failure ? failureDetail(failure) : '' };
  } catch (e) {
    return {
      ok: false,
      detail: failureDetail(failureFromLegacy(e instanceof Error ? e.message : String(e))),
    };
  }
}

/** 给 LLM 看的可用原子清单（按用途分组，prompt/工具描述用） */
export const ATOM_CATALOG = {
  移动: ['move_to', 'goto_position', 'walk', 'climb_up', 'pillar_up', 'dig_down', 'look_at'],
  战斗: ['attack', 'crit_jump_attack', 'kite', 'bow_shoot', 'block_with_shield'],
  采集造物: ['dig', 'mine_to', 'place_block', 'craft', 'smelt', 'use_tool', 'equip', 'equip_best_armor'],
  生存: ['eat', 'sleep', 'wake', 'escape_pit', 'fish'],
  容器载具: ['deposit', 'withdraw', 'mount', 'dismount', 'vehicle_goto'],
  跟随: ['follow_entity', 'stop_follow', 'stop'],
  交互: ['toss_item'],
} as const;

export function atomCatalogText(): string {
  return Object.entries(ATOM_CATALOG).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n');
}

/** 原子名 → 人话（任务树镜像节点展示用；铁律：不向主人暴露程序名词） */
const ATOM_ZH: Record<string, string> = {
  move_to: '移动到目标', goto_position: '走到坐标', walk: '行走', climb_up: '向上爬',
  pillar_up: '搭柱上升', dig_down: '向下挖', look_at: '转向',
  attack: '攻击', crit_jump_attack: '跳劈', kite: '风筝走位', bow_shoot: '射箭', block_with_shield: '举盾格挡',
  dig: '挖方块', mine_to: '挖到目标', place_block: '放置方块', craft: '合成', smelt: '熔炼',
  use_tool: '使用工具', equip: '装备', equip_best_armor: '换上最好护甲',
  eat: '进食', sleep: '睡觉', wake: '起床', escape_pit: '脱困', fish: '钓鱼',
  deposit: '存入容器', withdraw: '取出物品', mount: '骑乘', dismount: '下载具', vehicle_goto: '载具前往',
  follow_entity: '跟随', stop_follow: '停止跟随', stop: '停下',
  toss_item: '把物品交给主人',
};
const BEHAVIOR_ZH: Record<string, string> = {
  combat: '战斗',
  gather_block: '采集方块',
  farm_one_plot: '耕种一格',
  follow_owner: '跟随主人',
  flee: '撤离危险',
  craft_one: '合成物品',
};

/** 给任务树镜像子节点生成人话 label（带少量关键参数：数量/物品/坐标） */
export function atomDisplayLabel(atomic: string, args: Record<string, unknown>): string {
  if (atomic === 'invoke_behavior') {
    const beh = String((args.behavior ?? '') as string);
    return BEHAVIOR_ZH[beh] ?? '执行复合行为';
  }
  let base = ATOM_ZH[atomic] ?? '执行动作';
  const item = args.itemName ?? args.material ?? args.atomic;
  if (typeof item === 'string' && item) base += ` ${item}`;
  if (typeof args.count === 'number') base += ` ×${args.count}`;
  const pos = args.position as { x?: number; y?: number; z?: number } | undefined;
  if (pos && typeof pos.x === 'number') base += ` (${Math.round(pos.x)},${Math.round(pos.y ?? 0)},${Math.round(pos.z ?? 0)})`;
  return base;
}
