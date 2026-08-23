/**
 * 评测体系 · 核心契约（FEAT-CROSS-02 · 阶段〇）
 *
 * 定位：定义"一个场景怎么跑、怎么判成功、结果长什么样"的统一形状。
 * 不依赖 src/ 任何东西（纯类型），被 runner / scenarios / report 共享。
 *
 * 设计来源：设计文档 §2.5 ScenarioSpec 契约。
 */

import type { Director } from './director.js';
import type { Subject } from './subject.js';

/**
 * 场景所属套件（FEAT-CROSS-03）：
 *   quick  = 冒烟快跑（repeat 少）· 时长红线
 *   full   = 13 个钉名实例 · 基线比对（ID/判据稳定）
 *   matrix = 模板参数矩阵全量实例 · 大覆盖扫描，按需 --suite matrix
 */
export type Suite = 'quick' | 'full' | 'matrix';

/** 场景类目（报告分组用 · FEAT-CROSS-03） */
export type Category = 'nav' | 'recover' | 'gather' | 'craft' | 'follow' | 'survival' | 'combat';

/**
 * 单个评测场景规格。
 *
 * 生命周期（runner 逐个调用）：
 *   1. setup(d, s)   摆场：清场地 → 建结构 → tp/give/time/gamerule
 *   2. inject(s)     注入被测行为：submit move_to 请求 或 createTask+start
 *   3. (循环) sample(s)?  每 ~500ms 采样一次（FOLLOW 类累计距离用）
 *   4. success(s)    程序化判定成功（位置/库存/血量/任务态）
 *
 * 注意：scenarios 数组里存的是【工厂函数】而非实例，
 * 每次 repeat 调一次工厂拿到全新闭包，保证采样状态不串场。
 */
export interface ScenarioSpec {
  /** 场景 ID，如 'NAV-02' */
  id: string;
  /** 人类可读标题 */
  title: string;
  /** 所属套件 */
  suite: Suite;
  /** 类目（报告分组用 · FEAT-CROSS-03 · 由模板展开器注入） */
  category?: Category;
  /** 摆场：用导演 op 命令布置场地 + 安置被测 bot */
  setup(d: Director, s: Subject): Promise<void>;
  /** 注入被测行为（submit 请求 / 起任务 / 模拟聊天） */
  inject(s: Subject): Promise<void>;
  /** 可选 · 每个轮询周期调一次，用于累计采样（如跟随距离） */
  sample?(s: Subject): void;
  /** 程序化成功判定 · 每个轮询周期调一次，返回 true 即判成功 */
  success(s: Subject): boolean;
  /** 可选 · 提前判负（如死亡）· 每轮询调一次，true 即立即失败 reason='failfast'（FEAT-CROSS-03） */
  failFast?(s: Subject): boolean;
  /** 可选 · 超时存活判定 · 到 timeout 时若返回 true 则判成功（"存活 N 秒"类场景）（FEAT-CROSS-03） */
  endCheck?(s: Subject): boolean;
  /** 可选 · 每次运行结束后清场（SURV/COMB 清怪 + 还原难度/时间 · FEAT-CROSS-03） */
  teardown?(d: Director, s: Subject): Promise<void>;
  /** 单次运行时间预算 ms（超时即判失败 reason='timeout'） */
  timeoutMs: number;
  /** 重复次数（成功率 = 成功次数 / repeat） */
  repeat: number;
}

/** 单次运行结果 */
export interface RunResult {
  ok: boolean;
  durationMs: number;
  /** 失败原因（成功时 undefined）：'timeout' | 'error:xxx' | 自定义 */
  reason?: string;
  /** 本次运行期间 heartbeat.executing_watchdog 触发次数（AC3：正常应为 0） */
  watchdogHits: number;
}

/** 单个场景的汇总结果 */
export interface ScenarioResult {
  id: string;
  title: string;
  suite: Suite;
  /** 类目（报告分组用 · FEAT-CROSS-03） */
  category?: Category;
  repeat: number;
  /** 成功次数 */
  passed: number;
  /** 成功率 0..1 */
  successRate: number;
  /** 平均时长 ms（仅统计成功的，失败按 timeout 计入另算） */
  avgDurationMs: number;
  /** 全部运行的 watchdog 触发总数 */
  watchdogHits: number;
  /** 失败原因 Top3（reason → 次数） */
  topFailReasons: Array<{ reason: string; count: number }>;
  /** 逐次明细 */
  runs: RunResult[];
}

/** 整轮评测报告 */
export interface EvalReport {
  /** ISO 时间戳（由 runner 在落盘时注入，脚本内不取系统时间） */
  startedAt: string;
  finishedAt: string;
  suite: Suite;
  /** 服务器地址（host:port） */
  server: string;
  /** 各场景汇总 */
  scenarios: ScenarioResult[];
  /** 整体：总场景数 / 平均成功率 / watchdog 总触发 */
  summary: {
    totalScenarios: number;
    avgSuccessRate: number;
    totalWatchdogHits: number;
  };
}

/** 场景工厂：每次 repeat 调一次拿全新实例 */
export type ScenarioFactory = () => ScenarioSpec;
