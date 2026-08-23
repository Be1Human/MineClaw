/**
 * BUG-CROSS-36 · EventBus 是实时信号总线，MemoryV2 是可复盘业务记忆。
 * 高频调度 telemetry 只在总线上分发，不进入持久事件库。
 */
export const NON_DURABLE_EVENT_TYPES = [
  'heartbeat.rate_tick',
  'heartbeat.tick_done',
  'memory.commit',
  'critic_agent.run',
  'task.long_running',
] as const;

const NON_DURABLE = new Set<string>(NON_DURABLE_EVENT_TYPES);

export function isDurableEventType(type: string): boolean {
  return !NON_DURABLE.has(type);
}
