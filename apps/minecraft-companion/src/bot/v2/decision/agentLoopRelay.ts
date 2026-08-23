/**
 * L7 · Agent Loop Relay
 *
 * 订阅 EventBusV2 中的 L7 事件，组装结构化 AgentLoopStep 推送给外部（WebUI）。
 */

import type { EventBusV2 } from '../infra/eventBus.js';

export interface AgentLoopStep {
  turnId: string;
  round: number;
  timestamp: number;
  type: 'turn_start' | 'thinking' | 'tool_call' | 'tool_result' | 'tool_error' | 'turn_end';
  data: Record<string, unknown>;
}

export class AgentLoopRelay {
  private turnId = '';
  private unsubs: (() => void)[] = [];

  constructor(
    private readonly bus: EventBusV2,
    private readonly onStep: (step: AgentLoopStep) => void,
  ) {
    this.subscribe();
  }

  private subscribe(): void {
    const sub = (type: string, handler: (payload: Record<string, unknown>) => void) => {
      const unsub = this.bus.on(type, (ev) => handler(ev.payload as Record<string, unknown>));
      this.unsubs.push(unsub);
    };

    sub('l7.turn_started', (p) => {
      this.turnId = `turn-${Date.now()}`;
      this.emit('turn_start', 0, { userMessage: p.message ?? '' });
    });

    sub('l7.thought', (p) => {
      this.emit('thinking', (p.round as number) ?? 0, { thought: p.thought ?? '' });
    });

    sub('l7.tool_call', (p) => {
      this.emit('tool_call', (p.round as number) ?? 0, { tool: p.tool, input: p.input });
    });

    sub('l7.tool_use', (p) => {
      this.emit('tool_result', 0, { tool: p.name, ok: true, result: p.result, durationMs: p.durationMs ?? 0 });
    });

    sub('l7.tool_result', (p) => {
      this.emit('tool_result', (p.round as number) ?? 0, {
        tool: p.tool, ok: p.ok, result: p.result, durationMs: p.durationMs ?? 0,
      });
    });

    sub('l7.tool_error', (p) => {
      this.emit('tool_error', 0, { tool: p.name, error: p.error });
    });

    sub('l7.turn_finished', (p) => {
      this.emit('turn_end', 0, { reason: p.reason ?? 'end', rounds: p.rounds ?? 0 });
    });
  }

  private emit(type: AgentLoopStep['type'], round: number, data: Record<string, unknown>): void {
    this.onStep({
      turnId: this.turnId,
      round,
      timestamp: Date.now(),
      type,
      data,
    });
  }

  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
