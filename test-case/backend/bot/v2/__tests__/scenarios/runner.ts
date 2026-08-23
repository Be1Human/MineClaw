/**
 * ScenarioRunner — 场景测试框架
 *
 * 给定 setup（mock world 初始状态）+ timeline（scripted events 时序）
 * + assertions（最终/中间状态断言）· 一键跑场景
 */

import { V2Runtime, type V2RuntimeConfig } from '../../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import { createMockBot, type MockBot } from '../mocks/index.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

export interface TimelineEvent {
  atMs: number;
  action: (bot: MockBot, rt: V2Runtime) => void;
}

export interface ScenarioSetup {
  /**
   * Configure mock world state before V2Runtime starts
   */
  setup?: (bot: MockBot) => void;
  /**
   * Override V2Runtime config (merged with defaults)
   */
  runtimeConfig?: Partial<V2RuntimeConfig>;
}

export interface ScenarioResult {
  events: BusEvent[];
  runtime: V2Runtime;
  bot: MockBot;
}

export interface ScenarioOptions extends ScenarioSetup {
  /** Scripted timeline events */
  timeline?: TimelineEvent[];
  /** Total scenario duration in ms (default: 3000) */
  durationMs?: number;
}

/**
 * Run a scenario and return events + runtime + bot for assertions
 */
export async function runScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
  const bot = createMockBot();
  opts.setup?.(bot);

  const collectedEvents: BusEvent[] = [];

  // Create V2Runtime with mock bot
  const rt = new V2Runtime({
    game: bot.game,
    nav: bot.nav,
    ownerName: 'testOwner',
    tickMs: 50, // fast tick for tests
    blockingExecute: true,
    // BUG-CROSS-42：场景文件由 Node Test Runner 并行执行，不能回退到生产默认库。
    // 显式 runtimeConfig 放在其后，持久化/重启类场景仍可覆盖这些测试默认值。
    dbPath: ':memory:',
    worldMapDbPath: ':memory:',
    chatMemoryDbPath: ':memory:',
    ...(opts.runtimeConfig ?? {}),
    onEvent: (ev: BusEvent) => { collectedEvents.push(ev); },
  });

  // Start runtime
  rt.start();

  const durationMs = opts.durationMs ?? 3000;

  // Schedule timeline events
  for (const te of (opts.timeline ?? [])) {
    setTimeout(() => {
      te.action(bot, rt);
    }, te.atMs);
  }

  // Wait for scenario duration
  await new Promise(r => setTimeout(r, durationMs));

  // Stop runtime
  rt.stop();

  return { events: collectedEvents, runtime: rt, bot };
}

// ── Assertion helpers ─────────────────────────────────────────────

/** Check that an event of given type was emitted */
export function expectEventEmitted(
  events: BusEvent[],
  type: string,
  level?: string,
): void {
  const found = events.find(e => e.type === type && (!level || e.level === level));
  if (!found) {
    const types = events.map(e => e.type).join(', ');
    throw new Error(`Expected event '${type}' but not found. Got: [${types}]`);
  }
}

/** Check that NO event of given type was emitted */
export function expectEventNotEmitted(events: BusEvent[], type: string): void {
  const found = events.find(e => e.type === type);
  if (found) {
    throw new Error(`Expected event '${type}' NOT to be emitted, but it was.`);
  }
}

/** Check task state */
export function expectTaskState(
  rt: V2Runtime,
  taskKind: string,
  state: string,
): void {
  const tasks = rt.tasks.list();
  const task = tasks.find((t: { kind: string; state: string }) => t.kind === taskKind);
  if (!task) {
    throw new Error(`No task with kind='${taskKind}' found`);
  }
  if (task.state !== state) {
    throw new Error(`Task '${taskKind}': expected state='${state}' but got '${task.state}'`);
  }
}

/** Check strategy state via inspect() */
export function expectStrategyState(
  rt: V2Runtime,
  stratId: 'follow' | 'farm',
  view: Record<string, unknown>,
): void {
  const inspect = rt[stratId].inspect();
  for (const [key, val] of Object.entries(view)) {
    if ((inspect.view as Record<string, unknown>)[key] !== val) {
      throw new Error(
        `Strategy '${stratId}' view.${key}: expected ${JSON.stringify(val)} but got ${JSON.stringify((inspect.view as Record<string, unknown>)[key])}`,
      );
    }
  }
}
