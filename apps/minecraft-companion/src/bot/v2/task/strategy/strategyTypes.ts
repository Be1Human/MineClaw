/**
 * L6 · Strategy 固化物结构（FEAT-CROSS-07 R2）—— 符号化程序性记忆。
 *
 * 一次 LLM 慢思考做成的成功原子序列 → 沉淀成一棵带分支的【数据驱动行为树(BT)】，
 *   存为 JSON（data/strategies/<id>.json）、热加载、可审、可回滚、可递归复用。
 */

// ── BT 节点（BTInterpreter 解释执行）─────────────────────────
export type BTNode = BTSequence | BTFallback | BTCondition | BTAction | BTLoop;

/** 顺序：全成才成，一失败即失败 */
export interface BTSequence { type: 'sequence'; children: BTNode[]; }
/** 择一：一成即成（兜底/重试） */
export interface BTFallback { type: 'fallback'; children: BTNode[]; }
/** 判定：check 谓词查 WorldState；假 → 走 fallback 子树（无则判失败） */
export interface BTCondition { type: 'condition'; check: string; args?: Record<string, unknown>; fallback?: BTNode; }
/** 叶子动作：三选一执行源 atomic | behavior(L4) | strategy(递归) */
export interface BTAction {
  type: 'action';
  atomic?: string;       // executeAtomic
  behavior?: string;     // invoke_behavior（L4 BehaviorRegistry）
  strategy?: string;     // invoke_strategy（递归调另一棵固化 BT）
  args?: Record<string, unknown>;
}
/** 循环：跑 child 直到 until 谓词为真（或到 maxIterations 上限） */
export interface BTLoop { type: 'loop'; until: string; child: BTNode; maxIterations?: number; }

// ── Strategy 固化物 ──────────────────────────────────────────
export type StrategyState = 'candidate' | 'trusted' | 'blacklisted' | 'disabled';
export type OwnerVerdict = 'approved' | 'rejected' | null;

/** 硬门控（匹配时校验，不赌 LLM 感觉）+ 目标安全闸 */
export interface StrategyApplicability {
  appliesTo?: string[];     // 适用目标类别 ['hostile_entity','player','bot']
  excludes?: string[];      // 红线排除项 ['owner','friendly'] —— target∈excludes 直接拒
  preconditions?: string[]; // 前置条件谓词名 ['has_melee_weapon']
}

export interface StrategyLifecycle {
  state: StrategyState;
  confidence: number;       // 0~1 · 实时多维加权成功率（滑动窗口）
  trialRuns: number;        // 试用期累计执行次数
  cleanSuccess: number;     // 无降级成功累计（→ 晋升 trusted）
  recentRuns?: number[];    // 滑动窗口近期分（1=成功,0=失败/降级）
  deps: string[];           // invoke_strategy 引用的子 strategy id（循环检测用）
  ownerVerdict: OwnerVerdict; // 主人否决 > 自动评分
  createdAt?: number;
  updatedAt?: number;
}

export interface Strategy {
  id: string;
  name: string;             // = skill 指针名（agent 据此发现可调）
  description: string;
  params: string[];         // LLM 沉淀时抽出的参数槽（如 ['target']）
  applicability: StrategyApplicability;
  bt: BTNode;
  lifecycle: StrategyLifecycle;
}

// ── 执行结果 / 运行回灌 ───────────────────────────────────────
export type BTStatus = 'success' | 'failure' | 'preempted';
export interface BTResult { status: BTStatus; detail?: string; steps?: number; }

/** 一次 strategy 执行的多维打分原料（→ StrategyStore.recordRun → 置信度） */
export interface RunOutcome {
  ok: boolean;              // gate 是否达成
  downgraded?: boolean;     // 是否降级 slow 兜底
  durationMs?: number;
  hurt?: number;            // 受伤量
  safetyViolation?: boolean; // 误伤主人/友方 → 一票否决拉黑
}

export function newLifecycle(now: number): StrategyLifecycle {
  return { state: 'candidate', confidence: 0, trialRuns: 0, cleanSuccess: 0, recentRuns: [], deps: [], ownerVerdict: null, createdAt: now, updatedAt: now };
}
