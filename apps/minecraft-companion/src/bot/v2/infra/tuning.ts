/**
 * ⚙ 运行时可配参数中枢（铁律：不硬编码 · 全部实时可配）
 *
 * 所有行为调参集中在此，默认值写在 DEFAULTS，运行时可被 `data/tuning.json` 覆盖。
 * 热加载：每次读取最多缓存 1s，改 tuning.json 后 ≤1s 即时生效，**无需重启**。
 *
 * 用法：import { tuning } from '../infra/tuning.js';  const ms = tuning().l6.backoffMs[2];
 */
import { readFileSync, existsSync } from 'node:fs';

export interface TuningConfig {
  l6: {
    /** 连败退避时长 ms · [第1次, 第2次, 第≥3次] */
    backoffMs: [number, number, number];
    /** 连败达到此次数 → escalate（移交 LLM 慢脑） */
    escalateAtStrike: number;
    /** 外勤 trigger 命中后冷却 ms */
    triggerCooldownMs: number;
    /** 环境门：敌对实体安全半径（格） */
    hostileRadius: number;
    /** R5 死亡后全局战后冷却 ms */
    deathCooldownMs: number;
  };
  /** FEAT-L7-12 / GYM-BUG-04 · goto_position 走到固定坐标任务 */
  goto: {
    /** 到达判定距离（格）· 水平距 ≤ 此值即算到达、任务 success */
    arriveDist: number;
    /** 单次 goto_position 原子的寻路超时 ms */
    moveTimeoutMs: number;
    /** 无进展看门狗：连续 N tick 离目标距离不缩短 → 判 fail（防够不到死循环） */
    stallTicks: number;
  };
  /** FEAT-L1-07 · 退避式寻路（pathfinder 直冲 → 卡死才升级绕路） */
  nav: {
    /** L0 失败时，水平距目标 ≤ 此值 → 视为已尽力，不绕路（直接 L2） */
    stuckArriveDist: number;
    /** L1 绕路 waypoint 稀疏化间隔（格）· 每隔此距离取一个中继点 */
    detourWaypointGap: number;
    /** L1 绕路体素 A* 迭代上限（按需触发，可放大） */
    detourMaxIter: number;
  };
  /** BUG-CROSS-01 · 持续任务徒劳检测（永久运行零进展 → 唤醒慢脑） */
  futility: {
    /** 卡滞判定窗口 ms：策略处于 lost/seeking 且 bot 位移 < moveEpsilon 持续此时长 → 判徒劳 */
    stallMs: number;
    /** 位移阈值（格）· 窗口内移动超过此值视为有进展 */
    moveEpsilon: number;
    /** 同一任务 escalate 唤醒慢脑后的冷却 ms（防刷屏） */
    escalateCooldownMs: number;
  };
  /** BUG-CROSS-04 · 紧急脱困检测与执行参数。 */
  escape: {
    /** 普通坑脱困任务优先级。 */
    pitPriority: number;
    /** 岩浆逃生任务优先级；必须高于通用 reflex，避免同类保命动作互抢。 */
    lavaPriority: number;
    /** 单 tick 位移小于此值视为无进展。 */
    stuckDistance: number;
    /** 连续无进展 tick 达到此值才检测真坑。 */
    stuckTicks: number;
    /** 两次脱困动作间隔 tick。 */
    retryCooldownTicks: number;
    /** 最大脱困尝试次数。 */
    maxAttempts: number;
    /** 求助后的长冷却 tick。 */
    helpCooldownTicks: number;
    /** 可作为安全出口的最大落差。 */
    safeDrop: number;
    /** 岩浆逃离 walk 持续时间。 */
    lavaWalkMs: number;
  };
  /** BUG-L5-01 · 跟随主人（FollowStrategy + 动态 GoalFollow） */
  follow: {
    /** GoalFollow 到达停止距离（格）· bot 进此范围自动停、owner 走远自动追 */
    followRange: number;
    /** 连续不可见 N tick 才判真失联（防一帧遮挡误触发 seeking） */
    invisibleStreakTicks: number;
    /** seeking 到达目标坐标的判定距离（格） */
    seekArriveDist: number;
    /** seeking 到达后原地等待窗口 tick（owner 可能刚下矿车） */
    seekArriveWaitTicks: number;
    /** 真 lost（不知 owner 在哪）时问话冷却 ms */
    lostSayCooldownMs: number;
    /** 失联后按 owner 速度外推的 tick 数 */
    seekExtrapolateTicks: number;
    /** 外推最大格数（防冲过头） */
    seekExtrapolateMax: number;
    /** BUG-L5-02 · 主人移动触发强制重算总开关（true=跟手模式，false=纯 GoalFollow 懒重算） */
    repathOnOwnerMove: boolean;
    /** following 态主人位移超过此格数 → 强制重设 GoalFollow 打断懒重算 */
    repathMoveThreshold: number;
    /** 两次强制重算最小间隔 ms（防抖 pathfinder） */
    repathMinIntervalMs: number;
    /** BUG-L5-02 诊断 · 打印 bot↔owner 实时距离日志（定位迟钝用，平时关） */
    diagLog: boolean;
  };
  /** FEAT-CROSS-15 · 自动 Survival/Reflex 防御总开关（1s 热加载）。 */
  defense: {
    automaticEnabled: boolean;
  };
  /** FEAT-CROSS-20 · 研发 TestBench 默认关闭，仅允许显式热开启。 */
  testBench: {
    enabled: boolean;
  };
  /** FEAT-CROSS-25 · 可插拔主动 Tick 通用调度与错误隔离。 */
  proactiveTick: {
    /** 单插件一次只读评估的最大时长。 */
    evaluationTimeoutMs: number;
    /** 插件评估抛错或超时后的默认退避。 */
    errorBackoffMs: number;
    /** 主动租约请求释放后的最大等待时间；超时由准入层强制收敛。 */
    releaseTimeoutMs: number;
  };
  proactiveCapabilities: {
    autoFollow: { startDistance: number; stopDistance: number };
    autoStockpile: { targetLogs: number; targetFood: number; minHealth: number; dangerRadius: number; minFreeSlots: number };
  };
  /** FEAT-MEM-09 · 周期性对话记忆识别与整理。 */
  memoryConsolidation: {
    /** 总开关；关闭时保留原始消息、显式记忆和旧规则降级。 */
    enabled: boolean;
    /** 两次批量整理之间的间隔。 */
    intervalMs: number;
    /** 单批最多 owner 消息数。 */
    batchSize: number;
    /** 单批正文字符软预算；消息不会被截断后误结算。 */
    maxBatchChars: number;
    /** 提供给模型用于去重和冲突判断的 Active 事实上限。 */
    activeFactLimit: number;
    /** 单次模型请求超时。 */
    requestTimeoutMs: number;
    /** 单批模型最多提交的事实操作数。 */
    maxOperationsPerBatch: number;
    /** 每批提供给模型选择的官方槽位候选上限。 */
    slotCandidateLimit: number;
    /** 模型扩展候选自动晋升所需的独立主人证据数。 */
    dynamicPromotionEvidenceCount: number;
    /** 普通召回最多选择的官方槽位数。 */
    recallSlotLimit: number;
  };
  /** BUG-CROSS-82 · 跨进程游戏身份租约存活判定。 */
  gameConnectionLease: {
    /** 持有者刷新租约心跳的间隔。 */
    heartbeatIntervalMs: number;
    /** 超过此时长未刷新，竞争者可回收陈旧租约。 */
    staleAfterMs: number;
  };
  /** FEAT-L7-16 · 任务终态闭环推送（task_feedback 通道） */
  l7: {
    /** 任务终态去抖窗口 ms：窗口内多个 completed/failed/cancelled 合并成一次 task_feedback turn */
    taskFeedbackDebounceMs: number;
    /** busy/ask_master 占用时 task_feedback 的重试间隔 ms（等空闲再起，不丢） */
    taskFeedbackRetryMs: number;
  };
  /** FEAT-L7-15 · Agent Loop 内嵌 critic 节点 */
  l7Critic: {
    /** 总开关 · false = loop 退回裸 ReAct（零回归基线） */
    enabled: boolean;
    /** 判据模式（当前仅 rule，预留 llm/hybrid） */
    mode: 'rule' | 'llm' | 'hybrid';
    /** 单 turn 内 critic 触发 revise/block 的最大次数（防死循环） */
    maxRevise: number;
  };
  /** 单一 GoalAgent Loop 的预算与总开关。 */
  goalAgent: {
    /** 总开关 · false = MainBrain 不暴露 GoalAgent 游戏入口。 */
    enabled: boolean;
    /** 同一会话中的恢复次数上限。 */
    maxAttempt: number;
    /** 同一 GoalAgent 上下文的累计 LLM 调用上限。 */
    maxRoundsPerGoal: number;
    /** 任务级总 token 门；null 表示只计量、不以 token 终止任务。 */
    maxTotalTokensPerGoal: number | null;
    /** 单次调度片最多执行的模型 Round；到点只 yield。 */
    maxRoundsPerRun: number;
    /** 同一 GoalAgent 会话的累计动作上限。 */
    maxActionsPerGoal: number;
    /** BUG-CROSS-80 · 连续空搜索结果（knowledge/skill/capability）达到此次数 → 向主人发障碍反馈。 */
    feedbackEmptySearchStreak: number;
    /** BUG-CROSS-80 · llmCalls 达 maxLlmCalls 的该比例且未达成 → 向主人发预算告警。 */
    feedbackBudgetRatio: number;
    /** BUG-CROSS-80 · 连续该轮数未调用 action_execute（观察/搜索循环）→ 向主人发障碍反馈。 */
    feedbackInactiveRounds: number;
    /** BUG-CROSS-80 · 托管任务（craft_item/gather_material）单次最长执行 ms。 */
    managedTaskTimeoutMs: number;
    /** FEAT-CROSS-21 · 完成声明被复核拒绝后的同请求重试上限。 */
    confirmationRetryLimit: number;
  };
  /** FEAT-CROSS-07 · 技能固化闭环（Strategy 自学习）· 全参热加载零裸常量 */
  strategy: {
    /** 总开关 · false = 不沉淀、不查库（GoalAgent 永远走 slow） */
    enabled: boolean;
    /** candidate → trusted：累计无降级成功次数门槛 */
    promoteN: number;
    /** 置信度滑动窗口大小（近 N 次执行加权） */
    windowSize: number;
    /** trusted → candidate：置信度跌破此值退回候选 */
    demoteConfidence: number;
    /** 多维打分权重（加权成功率）：达成 gate / 耗时 vs slow 基线 / 受伤 / 是否降级 */
    weights: { gate: number; time: number; hurt: number; downgrade: number };
    /** StrategyMatcher 命中所需最低置信度（candidate 试用期可低，trusted 高） */
    minConfidenceToUse: number;
  };

  /** 原子后置验真（做完回查世界确认物理效果真发生）· 见 atomic/verifiers.ts */
  atomic: {
    /** 全局总开关 · false = 完全不验真（退回旧行为，只信 handler r.ok） */
    verifyEnabled: boolean;
    /** verify 判 fail 时的短轮询上限（给服务器同步留时间），ms */
    verifyTimeoutMs: number;
    /** 短轮询间隔，ms */
    verifyPollMs: number;
    /** 投递物品后等待拾取延迟结束再签发 success，防 Bot 回捡造成假交付。 */
    tossSettleMs: number;
    /** 每原子档位：off=不验 / observe=只告警不阻断 / enforce=判 fail 交 GoalAgent Recovery。未列入=off */
    verifyMode: Record<string, 'off' | 'observe' | 'enforce'>;
  };

  /** craft 原子 · 自动备工作台（兑现 needTable：3x3 配方缺台时自动找/放/造） */
  craft: {
    /** 找附近现成工作台的搜索半径（格） */
    tableSearchDist: number;
    /** 走到工作台前的到达半径（格），够得着才能合 3x3 */
    tableApproachRange: number;
    /** 走到工作台的寻路总超时，ms */
    tableApproachTimeoutMs: number;
    /** 走到工作台的寻路 think 预算，ms */
    tableApproachThinkMs: number;
    /** 单次 craft 原子内最多推进几步配方（防死循环）· 递归补子材料用 */
    maxCraftSteps: number;
    /** craft 原子就地采集材料时·源方块搜索半径（格） */
    gatherSearchDist: number;
    /** craft 原子就地采集材料时·最多挖几块（防死循环） */
    maxGatherBlocks: number;
  };

  /** BUG-CROSS-02 · smelt 原子 · 自洽熔炼（自动挑燃料 + 自动找/放/造熔炉） */
  smelt: {
    /** 找附近现成熔炉的搜索半径（格） */
    furnaceSearchDist: number;
    /** 走到熔炉前的到达半径（格），够得着才能开炉 */
    furnaceApproachRange: number;
    /** 走到熔炉的寻路总超时，ms */
    furnaceApproachTimeoutMs: number;
    /** 走到熔炉的寻路 think 预算，ms */
    furnaceApproachThinkMs: number;
    /** 走完仍超此距离即快速失败（够不到的旧炉），避免耗 20s windowOpen 空转（格） */
    furnaceMaxDist: number;
    /** 无燃料时就地采原木当燃料·采几个 */
    fuelGatherLogs: number;
  };
  /** BUG-L5-03 · 世界方块扫描（SLOW 心跳）· 防大半径暴力扫阻塞主进程事件循环 */
  worldScan: {
    /** 资源/箱子方块扫描半径（格）· findBlocks 体积 ∝ r³，越大越卡 */
    blockScanRadius: number;
    /** 单次扫描最多返回多少个目标方块 */
    blockScanCount: number;
    /** 矿物方块扫描半径（格） */
    mineralScanRadius: number;
    /** 矿物单次扫描最多返回多少个 */
    mineralScanCount: number;
    /** WorldMapCollector 地图采集半径（格）· 体积 ∝ r²·yRange，移动时每次全量扫 */
    mapScanRadius: number;
    /** WorldMapCollector Y 方向采集范围 ± */
    mapYRange: number;
  };
  /** FEAT-WEBUI-27 · 真实世界预览的数据流、渲染预算与资源包安全边界。 */
  worldVisual: {
    /** 总开关；关闭后仅保留现有简略感知。 */
    enabled: boolean;
    /** 以 Bot 所在区块为中心订阅的水平半径（区块）。 */
    viewDistanceChunks: number;
    /** 单帧允许用于构建真实方块网格的时间预算。 */
    sectionBuildBudgetMs: number;
    /** 单帧最多构建的区段数。 */
    maxSectionBuildsPerFrame: number;
    /** 解析模型和 Worker 网格构建的最大在途区段数。 */
    maxPendingSectionBuilds: number;
    /** 浏览器最多常驻的区段数，超出后按距离淘汰。 */
    maxResidentSections: number;
    /** 真实实体的最远渲染距离（格）。 */
    entityRenderDistance: number;
    /** 方块增量在服务端合并后发送的窗口。 */
    deltaBatchMs: number;
    /** 单个增量批次的最大去重后条目数，达到即提前发送。 */
    maxDeltaBatchEntries: number;
    /** 前端在 bootstrap 到达前最多暂存的增量批次数。 */
    maxQueuedDeltaBatches: number;
    /** 单个资源包压缩包最大字节数。 */
    maxPackBytes: number;
    /** 单个资源包最大 ZIP 条目数。 */
    maxPackEntries: number;
    /** 解压后单文件最大字节数。 */
    maxPackFileBytes: number;
    /** 资源包解压后的总字节数上限。 */
    maxExpandedPackBytes: number;
    /** 单条目最大压缩比，防止 ZIP 炸弹。 */
    maxCompressionRatio: number;
    /** PNG 最大宽高。 */
    maxImageDimension: number;
    /** 真实模式同时保留的实体模型上限。 */
    maxAuthenticEntities: number;
    /** 雨雪天气粒子上限。 */
    weatherParticleCount: number;
    /** 实体位置插值追赶时长。 */
    entityInterpolationMs: number;
    /** 天气粒子围绕观察中心的水平半径。 */
    weatherRadius: number;
    /** 天气粒子的下落速度（格/秒）。 */
    weatherFallSpeed: number;
    /** 不同维度的指数雾密度。 */
    fogDensity: {
      overworld: number;
      theNether: number;
      theEnd: number;
    };
    /** 降雨时的雾密度倍数。 */
    rainFogMultiplier: number;
    /** 真实模式中不受昼夜与天气压暗的柔和半球补光强度。 */
    ambientFillLightIntensity: number;
  };
}

const DEFAULTS: TuningConfig = {
  l6: {
    backoffMs: [60_000, 5 * 60_000, 30 * 60_000],
    escalateAtStrike: 3,
    triggerCooldownMs: 60_000,
    hostileRadius: 16,
    deathCooldownMs: 5 * 60_000,
  },
  goto: {
    arriveDist: 3,
    moveTimeoutMs: 20_000,
    stallTicks: 200,
  },
  nav: {
    stuckArriveDist: 4,
    detourWaypointGap: 8,
    detourMaxIter: 50_000,
  },
  futility: {
    stallMs: 90_000,
    moveEpsilon: 2,
    escalateCooldownMs: 5 * 60_000,
  },
  escape: {
    pitPriority: 92,
    lavaPriority: 100,
    stuckDistance: 0.25,
    stuckTicks: 14,
    retryCooldownTicks: 26,
    maxAttempts: 4,
    helpCooldownTicks: 300,
    safeDrop: 6,
    lavaWalkMs: 1200,
  },
  follow: {
    followRange: 2,
    invisibleStreakTicks: 4,
    seekArriveDist: 5,
    seekArriveWaitTicks: 6,
    lostSayCooldownMs: 30_000,
    seekExtrapolateTicks: 10,
    seekExtrapolateMax: 8,
    repathOnOwnerMove: true,
    repathMoveThreshold: 2,
    repathMinIntervalMs: 400,
    diagLog: false,
  },
  defense: {
    automaticEnabled: true,
  },
  testBench: {
    enabled: false,
  },
  proactiveTick: {
    evaluationTimeoutMs: 1_000,
    errorBackoffMs: 30_000,
    releaseTimeoutMs: 2_000,
  },
  proactiveCapabilities: {
    autoFollow: { startDistance: 8, stopDistance: 4 },
    autoStockpile: { targetLogs: 32, targetFood: 16, minHealth: 16, dangerRadius: 16, minFreeSlots: 4 },
  },
  memoryConsolidation: {
    enabled: true,
    intervalMs: 300_000,
    batchSize: 40,
    maxBatchChars: 8_000,
    activeFactLimit: 100,
    requestTimeoutMs: 60_000,
    maxOperationsPerBatch: 24,
    slotCandidateLimit: 20,
    dynamicPromotionEvidenceCount: 2,
    recallSlotLimit: 8,
  },
  gameConnectionLease: {
    heartbeatIntervalMs: 5_000,
    staleAfterMs: 60_000,
  },
  l7: {
    taskFeedbackDebounceMs: 1500,
    taskFeedbackRetryMs: 3000,
  },
  l7Critic: {
    enabled: true,
    mode: 'rule',
    maxRevise: 2,
  },
  goalAgent: {
    enabled: true,
    maxAttempt: 3,
    maxRoundsPerGoal: 120,
    maxTotalTokensPerGoal: null,
    maxRoundsPerRun: 20,
    maxActionsPerGoal: 80,
    feedbackEmptySearchStreak: 3,
    feedbackBudgetRatio: 0.8,
    feedbackInactiveRounds: 5,
    managedTaskTimeoutMs: 110_000,
    confirmationRetryLimit: 1,
  },
  strategy: {
    enabled: true,
    promoteN: 3,
    windowSize: 10,
    demoteConfidence: 0.4,
    weights: { gate: 0.6, time: 0.15, hurt: 0.15, downgrade: 0.1 },
    minConfidenceToUse: 0.0, // 候选试用期即可上场（靠降级护栏兜底）；可调高只用可信
  },
  atomic: {
    verifyEnabled: true,
    verifyTimeoutMs: 400,
    verifyPollMs: 80,
    tossSettleMs: 2_500,
    verifyMode: {
      // 高确信（物理事实清晰）→ enforce 判败
      place_block: 'enforce', place_scaffold: 'enforce', dig: 'enforce',
      craft: 'enforce', equip: 'enforce', eat: 'enforce',
      // FEAT-L3-13 · 扔物品：背包数下降是确定性事实 → enforce
      toss_item: 'enforce',
      // 低确信（易 unknown / 时序敏感）→ observe 只告警，真服观察后再升 enforce
      attack: 'observe', crit_jump_attack: 'observe', bow_shoot: 'observe',
      fish: 'observe', equip_best_armor: 'observe',
    },
  },
  craft: {
    tableSearchDist: 10,
    tableApproachRange: 2,
    tableApproachTimeoutMs: 12_000,
    tableApproachThinkMs: 4_000,
    maxCraftSteps: 24,
    gatherSearchDist: 32,
    maxGatherBlocks: 64,
  },
  smelt: {
    furnaceSearchDist: 10,
    furnaceApproachRange: 2,
    furnaceApproachTimeoutMs: 9_000,
    furnaceApproachThinkMs: 3_000,
    furnaceMaxDist: 4.5,
    fuelGatherLogs: 2,
  },
  worldScan: {
    blockScanRadius: 16,
    blockScanCount: 16,
    mineralScanRadius: 16,
    mineralScanCount: 24,
    mapScanRadius: 16,
    mapYRange: 8,
  },
  worldVisual: {
    enabled: true,
    viewDistanceChunks: 3,
    sectionBuildBudgetMs: 6,
    maxSectionBuildsPerFrame: 2,
    maxPendingSectionBuilds: 4,
    maxResidentSections: 512,
    entityRenderDistance: 96,
    deltaBatchMs: 100,
    maxDeltaBatchEntries: 512,
    maxQueuedDeltaBatches: 32,
    maxPackBytes: 64 * 1024 * 1024,
    maxPackEntries: 20_000,
    maxPackFileBytes: 16 * 1024 * 1024,
    maxExpandedPackBytes: 256 * 1024 * 1024,
    maxCompressionRatio: 100,
    maxImageDimension: 8192,
    maxAuthenticEntities: 128,
    weatherParticleCount: 900,
    entityInterpolationMs: 120,
    weatherRadius: 32,
    weatherFallSpeed: 18,
    fogDensity: {
      overworld: 0.004,
      theNether: 0.018,
      theEnd: 0.009,
    },
    rainFogMultiplier: 1.45,
    ambientFillLightIntensity: 0.5,
  },
};

const FILE = process.env.TUNING_FILE || 'data/tuning.json';
let cache: TuningConfig | null = null;
let cacheAt = 0;

function deepMerge<T>(base: T, over: unknown): T {
  if (over == null || typeof over !== 'object') return base;
  const out: Record<string, unknown> = Array.isArray(base) ? [...(base as unknown[])] as never : { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (out as Record<string, unknown>)[k];
    out[k] = (b && typeof b === 'object' && v && typeof v === 'object' && !Array.isArray(v))
      ? deepMerge(b, v) : v;
  }
  return out as T;
}

/** 程序化覆盖（仅测试用 · 叠在 DEFAULTS+文件 之上）。生产代码不调。 */
let testOverride: Record<string, unknown> | null = null;
export function __setTuningOverride(o: Record<string, unknown> | null): void {
  testOverride = o;
  cache = null; // 绕过缓存，立即生效
}

/** 读取当前生效配置（热加载 · 1s 缓存） */
export function tuning(): TuningConfig {
  const now = Date.now();
  if (!testOverride && cache && now - cacheAt < 1000) return cache;
  let override: unknown = {};
  try { if (existsSync(FILE)) override = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 容错：坏 json 用默认 */ }
  let merged = deepMerge(DEFAULTS, override);
  if (testOverride) merged = deepMerge(merged, testOverride);
  cache = merged;
  cacheAt = now;
  return cache;
}

export const tuningDefaults = DEFAULTS;
