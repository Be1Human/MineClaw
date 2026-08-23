import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { BusEvent } from '../types.js';
import type { TestCard } from './cards.js';

export type BenchLane = 'decision' | 'task' | 'strategy' | 'execution' | 'world' | 'misc';
export type RunVerdict = { status: 'pass' | 'fail' | 'aborted' | 'timeout'; reason?: string };

export interface RunTraceEvent {
  ts: number;
  kind: 'event' | 'sample' | 'verdict';
  lane?: BenchLane;
  type: string;
  level?: string;
  payload: unknown;
}

export interface RunSummary {
  runId: string;
  cardId: string;
  startedAt: number;
  endedAt?: number;
  verdict?: RunVerdict;
  eventCount: number;
  truncated: boolean;
}

export function laneOf(type: string): BenchLane {
  if (type.startsWith('l7.') || type.startsWith('decision.') || type.startsWith('goalagent.')) return 'decision';
  if (type.startsWith('task.')) return 'task';
  if (type.startsWith('gather.') || type.startsWith('strategy.')) return 'strategy';
  if (type.startsWith('atomic.') || type.startsWith('exec.') || type.startsWith('motor.')) return 'execution';
  if (type.startsWith('under_attack') || type.startsWith('bot.death') || type.startsWith('narration.')) return 'world';
  return 'misc';
}

/**
 * FEAT-CROSS-04：只读旁路记录器。它不干预执行队列；每个 Run 独占一个 JSONL 文件。
 */
export class RunRecorder {
  private unsub: (() => void) | null = null;
  private active: RunSummary | null = null;
  private file = '';
  private bytes = 0;

  constructor(
    private readonly bus: EventBusV2,
    private readonly runsDir = join('data', 'runs'),
    private readonly maxBytes = 20 * 1024 * 1024,
  ) {}

  start(runId: string, cardId: string): RunSummary {
    if (this.active) throw new Error(`run already active: ${this.active.runId}`);
    mkdirSync(this.runsDir, { recursive: true });
    this.file = join(this.runsDir, `${safeId(runId)}.jsonl`);
    this.bytes = 0;
    this.active = { runId, cardId, startedAt: Date.now(), eventCount: 0, truncated: false };
    this.write({ ts: this.active.startedAt, kind: 'event', type: 'bench.run_started', payload: { runId, cardId } });
    this.unsub = this.bus.onAny(event => this.recordEvent(event));
    return { ...this.active };
  }

  sample(payload: unknown): void {
    if (!this.active) return;
    this.write({ ts: Date.now(), kind: 'sample', type: 'bench.sample', payload });
  }

  stop(verdict: RunVerdict): RunSummary | null {
    if (!this.active) return null;
    this.unsub?.();
    this.unsub = null;
    this.write({ ts: Date.now(), kind: 'verdict', type: 'bench.verdict', payload: verdict });
    this.active.endedAt = Date.now();
    this.active.verdict = verdict;
    const result = { ...this.active };
    this.active = null;
    this.file = '';
    return result;
  }

  current(): RunSummary | null { return this.active ? { ...this.active } : null; }

  list(): RunSummary[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir).filter(name => name.endsWith('.jsonl')).map(name => {
      const entries = readRunTrace(join(this.runsDir, name));
      const first = entries[0];
      const verdict = entries.find(entry => entry.kind === 'verdict')?.payload as RunVerdict | undefined;
      return {
        runId: name.slice(0, -6), cardId: String((first?.payload as { cardId?: string } | undefined)?.cardId ?? 'unknown'),
        startedAt: first?.ts ?? statSync(join(this.runsDir, name)).birthtimeMs,
        endedAt: entries.at(-1)?.ts, verdict, eventCount: entries.length, truncated: false,
      };
    }).sort((a, b) => b.startedAt - a.startedAt);
  }

  trace(runId: string): RunTraceEvent[] { return readRunTrace(join(this.runsDir, `${safeId(runId)}.jsonl`)); }

  /**
   * 将可诊断的失败固化为独立的可携带证据包。原始 trace 保留在 runs 根目录，
   * 归档副本用于附到缺陷或交给其他人复现；主动中止不应污染失败样本。
   */
  archiveFailure(summary: RunSummary, card: TestCard): string | null {
    if (!summary.verdict || !['fail', 'timeout'].includes(summary.verdict.status)) return null;
    const traceFile = join(this.runsDir, `${safeId(summary.runId)}.jsonl`);
    if (!existsSync(traceFile)) return null;
    const archiveDir = join(this.runsDir, 'failed', safeId(summary.runId));
    mkdirSync(archiveDir, { recursive: true });
    copyFileSync(traceFile, join(archiveDir, 'trace.jsonl'));
    writeFileSync(join(archiveDir, 'card.json'), `${JSON.stringify(card, null, 2)}\n`, 'utf8');
    writeFileSync(join(archiveDir, 'repro.txt'), this.reproScript(card, summary), 'utf8');
    return archiveDir;
  }

  private recordEvent(event: BusEvent): void {
    if (!this.active) return;
    this.write({ ts: event.timestamp, kind: 'event', lane: laneOf(event.type), type: event.type, level: event.level, payload: event.payload });
  }

  private write(entry: RunTraceEvent): void {
    if (!this.active || this.active.truncated) return;
    const line = `${JSON.stringify(entry)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.maxBytes) { this.active.truncated = true; return; }
    appendFileSync(this.file, line, 'utf8');
    this.bytes += size;
    this.active.eventCount++;
  }

  private reproScript(card: TestCard, summary: RunSummary): string {
    const reason = summary.verdict?.reason ?? 'unknown';
    return [
      `# MineClaw TestBench reproduction: ${summary.runId}`,
      `# verdict: ${summary.verdict?.status ?? 'unknown'}; reason: ${reason}`,
      '# Run the setup commands with an operator-enabled bot, then submit this card:',
      ...card.setup,
      `#test ${card.id}`,
      '',
    ].join('\n');
  }
}

export function readRunTrace(file: string): RunTraceEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as RunTraceEvent]; } catch { return []; }
  });
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '_'); }
