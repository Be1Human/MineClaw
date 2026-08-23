/**
 * MineFriend v2.0 · 入口导出
 *
 * 当前实现的场景：跟着我（玩家说"跟着我" → 任务下发 → 稳态 follow → 遇袭恢复）
 *
 * 层次：
 *   L7  · MainBrain（rule-based Tool Use Loop，LLM hook 已留）
 *   L7' · Runtime Supervisor
 *   L6  · Task Runtime（含 FollowOwnerTask）
 *   L5  · FollowStrategy / ReflexStrategy
 *   L3-L4 · executeAtomic（move_to / follow_entity / attack / say / stop）
 *
 * 基础设施：
 *   #1 EventBus（四级 critical/recoverable/suggestion/info）
 *   #2 Heartbeat（10 步 tick + ActionArbitrator）
 *   #3 Perception（4 段管线 + WorldState Store）
 *   #4 Memory（RuntimeState + 持久 Task/Spatial）
 */

export { V2Runtime } from './v2Runtime.js';
export type { PlannerEvolutionMode, V2RuntimeConfig } from './v2Runtime.js';
export type * from './types.js';
export { EventBusV2 } from './infra/eventBus.js';
export { MemoryV2 } from './infra/memory.js';
