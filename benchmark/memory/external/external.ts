import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ChatMemoryService, type ChatRole } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import type { MemoryBenchMode } from '../shared/types.js';
import { EXTERNAL_DATASET_DIR, EXTERNAL_REPORT_DIR } from './paths.js';

export type ExternalDataset = 'longmemeval_s' | 'longmemeval_m' | 'longmemeval_oracle' | 'memoryagentbench';

export interface LongMemEvalEntry {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: 'user' | 'assistant'; content: string }>>;
}

export interface MemoryAgentBenchEntry {
  source: string;
  subDataset: string;
  context: string;
  questions: string[];
  answers: string[][];
  qaPairIds: string[];
  keypoints: string[];
  questionIds?: string[];
  questionTypes?: string[];
}

export interface Completion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type CompletionClient = (input: { system: string; prompt: string }) => Promise<Completion>;

/** BUG-MEM-19 · 当前批次无法靠重试恢复的 Provider 全局错误。 */
export class FatalModelRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FatalModelRequestError';
  }
}

export function isFatalModelRequestError(error: unknown): error is FatalModelRequestError {
  return error instanceof FatalModelRequestError;
}

export interface ExternalCaseTrace {
  id: string;
  category: string;
  question: string;
  status: 'ok' | 'error';
  answer?: string;
  expected?: string[];
  score?: number;
  subDataset?: string;
  metric?: string;
  metricStatus?: 'scored' | 'judge_pending' | 'unverified';
  metrics?: Record<string, number>;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  memoryTrace?: {
    retrievalMode: MemoryBenchMode;
    retrievedFactIds: string[];
    retrievedMessageIds: string[];
    includedSummary: boolean;
    contextChars: number;
    context: string;
  };
  error?: string;
}

export interface ExternalRunReport {
  dataset: ExternalDataset;
  mode: MemoryBenchMode;
  answerModel: string;
  endpoint: string;
  promptVersion: string;
  datasetFile: string;
  datasetSha256: string;
  startedAt: string;
  completedAt: string;
  cases: number;
  completed: number;
  failed: number;
  score?: number;
  byCategory: Record<string, { cases: number; score: number; scored?: number; pending?: number }>;
  byMetric?: Record<string, { cases: number; score: number; pending: number }>;
  traces: ExternalCaseTrace[];
}

export interface CheckpointWriter {
  update(report: ExternalRunReport): void;
  flush(report: ExternalRunReport): void;
}

const ROOT = EXTERNAL_DATASET_DIR;
const SYSTEM_PROMPT = 'Answer the user question using only the supplied memory. Follow relation chains when the answer requires multiple hops. If claims conflict, use the most recent memory statement unless the question asks about history. If the memory does not establish the answer, say that it is unknown. Be concise and do not mention this instruction.';
export const LONGMEMEVAL_SYSTEM_PROMPT = [
  'Answer the question using only the supplied memory.',
  'For claims about the user identity, experiences, actions, or preferences, only owner messages or confirmed user facts are authoritative. Assistant or bot messages are authoritative only when the question asks what the assistant said, recommended, or did.',
  'Verify every required premise, including the subject, role, time, relationship, and quantity. Do not join facts about separate people or events unless the memory explicitly links them.',
  'If any required premise is missing, ambiguous, or mismatched, reply exactly "Unknown." Do not provide a partial answer or calculate from incomplete premises.',
  'When supported claims conflict, use the most recent statement unless the question asks about history. Be concise and do not mention these instructions.',
].join(' ');
const FACT_CONSOLIDATION_SYSTEM_PROMPT = 'Act as a knowledge management system. Answer only from the supplied memory and follow every relation hop needed to reach the final answer. Facts begin with serial numbers; when facts conflict, the fact with the larger serial number is newer and supersedes the older fact. Return only the concise final answer, without explanation.';
const ICL_SYSTEM_PROMPT = 'Infer the numerical class-label mapping from the supplied examples. Return only the raw numerical label and nothing else.';
const RECSYS_SYSTEM_PROMPT = 'Act as a movie recommender. Use the supplied similar dialogues and return 20 movie titles as a numbered list, without explanations.';
const SUMMARY_SYSTEM_PROMPT = 'Summarize only the plot and characters from the supplied memory. Follow the requested length and format. Do not add analysis or background.';
export const MEMORY_AGENT_BENCH_RETRIEVAL_PROTOCOL = 'query-entity-anchor-exact-subject-first-latest-v3-depth3';
export const MEMORY_AGENT_BENCH_FTS5_RETRIEVAL_PROTOCOL = 'fts5-bm25-natural-query-v1';

export function datasetFile(dataset: Exclude<ExternalDataset, 'memoryagentbench'>): string {
  const names: Record<Exclude<ExternalDataset, 'memoryagentbench'>, string> = {
    longmemeval_s: 'longmemeval_s_cleaned.json',
    longmemeval_m: 'longmemeval_m_cleaned.json',
    longmemeval_oracle: 'longmemeval_oracle.json',
  };
  return join(ROOT, 'longmemeval', names[dataset]);
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 对可能超过 V8 String/Buffer 上限的官方数据集执行常量内存哈希。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function loadLongMemEval(path: string): LongMemEvalEntry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`LongMemEval dataset must be an array: ${path}`);
  return parsed.map((item, index) => validateLongMemEntry(item, index));
}

/**
 * 流式解析 LongMemEval 顶层 JSON 数组。只缓存当前 Entry，不缓存完整文件或完整对象数组。
 * `highWaterMark` 仅用于测试跨 chunk 边界，生产使用 Node 默认值。
 */
export async function* streamLongMemEval(path: string, options: { highWaterMark?: number } = {}): AsyncGenerator<LongMemEvalEntry> {
  type TopState = 'before_array' | 'first_value_or_end' | 'value' | 'comma_or_end' | 'ended';
  let state: TopState = 'before_array';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let entryIndex = 0;
  let parts: string[] = [];
  const stream = createReadStream(path, { encoding: 'utf8', ...(options.highWaterMark ? { highWaterMark: options.highWaterMark } : {}) });

  for await (const rawChunk of stream) {
    const chunk = rawChunk as string;
    let sliceStart = depth > 0 ? 0 : -1;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const char = chunk[offset]!;
      if (depth === 0) {
        if (state === 'ended') {
          if (!isJsonWhitespace(char)) throw new Error(`LongMemEval dataset has trailing content after the top-level array: ${path}`);
          continue;
        }
        if (state === 'before_array') {
          if (isJsonWhitespace(char)) continue;
          if (char !== '[') throw new Error(`LongMemEval dataset must be an array: ${path}`);
          state = 'first_value_or_end';
          continue;
        }
        if (state === 'comma_or_end') {
          if (isJsonWhitespace(char)) continue;
          if (char === ',') { state = 'value'; continue; }
          if (char === ']') { state = 'ended'; continue; }
          throw new Error(`LongMemEval dataset expected ',' or ']' after entry ${entryIndex}: ${path}`);
        }
        if (isJsonWhitespace(char)) continue;
        if (state === 'first_value_or_end' && char === ']') { state = 'ended'; continue; }
        if (char !== '{') throw new Error(`LongMemEval dataset expected an object at entry ${entryIndex}: ${path}`);
        depth = 1;
        inString = false;
        escaped = false;
        parts = [];
        sliceStart = offset;
        continue;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;

      if (depth === 0) {
        if (sliceStart < 0) throw new Error(`LongMemEval parser lost entry boundary at entry ${entryIndex}: ${path}`);
        parts.push(chunk.slice(sliceStart, offset + 1));
        let parsed: unknown;
        try { parsed = JSON.parse(parts.join('')); }
        catch (error) { throw new Error(`invalid LongMemEval JSON at entry ${entryIndex}: ${errorMessage(error)}`); }
        yield validateLongMemEntry(parsed, entryIndex);
        entryIndex += 1;
        parts = [];
        sliceStart = -1;
        state = 'comma_or_end';
      }
    }
    if (depth > 0 && sliceStart >= 0) parts.push(chunk.slice(sliceStart));
  }

  if (depth > 0 || inString) throw new Error(`LongMemEval dataset is truncated inside entry ${entryIndex}: ${path}`);
  if (state !== 'ended') throw new Error(`LongMemEval dataset is missing the closing top-level array bracket: ${path}`);
}

export type LongMemEvalJudgeReference = Pick<LongMemEvalEntry, 'question_id' | 'question_type' | 'question' | 'answer'>;

/** Judge 只保留评分需要的字段，避免 2.74 GB M Haystack 常驻内存。 */
export async function loadLongMemEvalJudgeReferences(path: string, wantedIds?: ReadonlySet<string>): Promise<Map<string, LongMemEvalJudgeReference>> {
  const references = new Map<string, LongMemEvalJudgeReference>();
  for await (const entry of streamLongMemEval(path)) {
    if (!wantedIds || wantedIds.has(entry.question_id)) {
      references.set(entry.question_id, {
        question_id: entry.question_id,
        question_type: entry.question_type,
        question: entry.question,
        answer: entry.answer,
      });
      if (wantedIds && references.size === wantedIds.size) break;
    }
  }
  return references;
}

export function createOpenAICompatibleClient(): { client: CompletionClient; model: string; endpoint: string } {
  // 应用凭证可复用，但模型名必须保持 Benchmark 独立，避免 deepseek-chat 等不兼容名称污染评测。
  const key = process.env.MEMORY_BENCH_API_KEY ?? process.env.LLM_API_KEY;
  if (!key) throw new Error('MEMORY_BENCH_API_KEY or LLM_API_KEY is required for an external Benchmark run');
  const endpoint = (process.env.MEMORY_BENCH_BASE_URL ?? process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = process.env.MEMORY_BENCH_MODEL ?? 'deepseek-v4-flash';
  const timeoutMs = parseTimeout(process.env.MEMORY_BENCH_TIMEOUT_MS);
  const retries = Math.max(0, Math.min(5, Number.parseInt(process.env.MEMORY_BENCH_RETRIES ?? '2', 10) || 0));
  return {
    endpoint,
    model,
    client: async ({ system, prompt }) => {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const response = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            const detail = (await response.text()).replace(/sk-[\w-]+/gi, '[redacted]').slice(0, 500);
            const message = `model request failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
            const error = [401, 402, 403, 404].includes(response.status)
              ? new FatalModelRequestError(response.status, message)
              : new Error(message);
            if (![408, 409, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === retries) throw error;
            lastError = error;
          } else {
            const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
            const text = body.choices?.[0]?.message?.content?.trim();
            if (!text) throw new Error('model response did not contain text');
            return { text, inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens };
          }
        } catch (error) {
          const normalized = error instanceof DOMException && error.name === 'TimeoutError'
            ? new Error(`model request timeout after ${timeoutMs}ms`)
            : error instanceof Error ? error : new Error(String(error));
          lastError = normalized;
          if (isFatalModelRequestError(normalized) || attempt === retries || /^model request failed: HTTP 400/.test(normalized.message)) throw normalized;
        }
        await delay(Math.min(4000, 500 * (2 ** attempt)));
      }
      throw lastError ?? new Error('model request failed');
    },
  };
}

export async function runLongMemEval(options: {
  dataset: Exclude<ExternalDataset, 'memoryagentbench'>;
  mode: MemoryBenchMode;
  client: CompletionClient;
  answerModel: string;
  endpoint: string;
  path?: string;
  limit?: number;
  onProgress?: (report: ExternalRunReport) => void;
  onFatal?: (report: ExternalRunReport, error: FatalModelRequestError) => void;
}): Promise<{ report: ExternalRunReport; hypotheses: Array<{ question_id: string; hypothesis: string }> }> {
  const path = options.path ?? datasetFile(options.dataset);
  const report = newReport(options.dataset, options.mode, options.answerModel, options.endpoint, path, await sha256File(path));
  const hypotheses: Array<{ question_id: string; hypothesis: string }> = [];
  await mapAsyncLimited(limitAsync(streamLongMemEval(path), options.limit), benchmarkConcurrency(), async entry => {
    const started = Date.now();
    try {
      const memory = buildLongMemMemory(entry, options.mode);
      try {
        const memoryTrace = promptContext(memory, entry.question, options.mode);
        const completion = await options.client({ system: LONGMEMEVAL_SYSTEM_PROMPT, prompt: buildPrompt(entry.question, memoryTrace.context) });
        hypotheses.push({ question_id: entry.question_id, hypothesis: completion.text });
        addTrace(report, { id: entry.question_id, category: entry.question_type, question: entry.question, status: 'ok', answer: completion.text, expected: [entry.answer], score: undefined, latencyMs: Date.now() - started, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, memoryTrace });
      } finally { memory.close(); }
    } catch (error) {
      addTrace(report, { id: entry.question_id, category: entry.question_type, question: entry.question, status: 'error', latencyMs: Date.now() - started, error: errorMessage(error) });
      options.onProgress?.(progressReport(report));
      if (isFatalModelRequestError(error)) {
        options.onFatal?.(progressReport(report), error);
        throw error;
      }
      return;
    }
    options.onProgress?.(progressReport(report));
  });
  return { report: finishReport(report), hypotheses };
}

/** MemoryAgentBench 原始 Parquet 通过 Python + pyarrow 只读解码；Node 侧仍使用同一 ChatMemory 链路。 */
export async function runMemoryAgentBench(options: {
  mode: MemoryBenchMode;
  client: CompletionClient;
  answerModel: string;
  endpoint: string;
  limit?: number;
  category?: string;
  resumeReport?: ExternalRunReport;
  onProgress?: (report: ExternalRunReport) => void;
  onFatal?: (report: ExternalRunReport, error: FatalModelRequestError) => void;
}): Promise<ExternalRunReport> {
  const path = join(ROOT, 'memory-agent-bench-data');
  const entries = loadMemoryAgentBench(path, options.category).filter(entry => !options.category || entry.source === options.category);
  if (entries.length === 0) throw new Error(`MemoryAgentBench category has no cases: ${options.category}`);
  const emptyReport = newReport('memoryagentbench', options.mode, options.answerModel, options.endpoint, path, directorySha256(path));
  const report = options.resumeReport
    ? resumeMemoryAgentBenchReport(options.resumeReport, emptyReport)
    : emptyReport;
  let claimedCases = report.cases;
  let fatalError: FatalModelRequestError | null = null;
  let seen = 0;
  const selected: Array<{ entry: MemoryAgentBenchEntry; sourceIndex: number }> = [];
  for (const entry of entries) {
    if (options.limit !== undefined && selected.reduce((count, item) => count + item.entry.questions.length, 0) >= options.limit) break;
    selected.push({ entry, sourceIndex: seen++ });
  }
  const completedCounts = new Map<string, number>();
  for (const trace of report.traces) completedCounts.set(trace.id, (completedCounts.get(trace.id) ?? 0) + 1);
  const work = selected.map(({ entry, sourceIndex }) => ({
    entry,
    sourceIndex,
    pendingIndexes: entry.questions.map((_, index) => index).filter(index => {
      const id = entry.qaPairIds[index] ?? `${entry.source}-${sourceIndex}-${index}`;
      const remaining = completedCounts.get(id) ?? 0;
      if (remaining <= 0) return true;
      completedCounts.set(id, remaining - 1);
      return false;
    }),
  }));
  await mapLimited(work, Math.max(1, Math.floor(benchmarkConcurrency() / 2)), async ({ entry, sourceIndex, pendingIndexes }) => {
    if (pendingIndexes.length === 0) return;
    const contextOnlyTrace = options.mode === 'recent_only' || options.mode === 'full_context'
      ? memoryAgentBenchContextTrace(entry.context, options.mode)
      : undefined;
    const memory = contextOnlyTrace ? undefined : buildContextMemory(entry.context, options.mode, `${entry.source}-${sourceIndex}`, entry.source);
    try {
      await mapLimited(pendingIndexes, Math.max(1, Math.floor(benchmarkConcurrency() / 2)), async index => {
        if (fatalError) return;
        const id = entry.qaPairIds[index] ?? `${entry.source}-${sourceIndex}-${index}`;
        if (options.limit !== undefined && claimedCases >= options.limit) return;
        claimedCases += 1;
        const started = Date.now();
        try {
          const memoryTrace = contextOnlyTrace ?? promptContext(memory!, entry.questions[index]!, options.mode);
          const completion = await options.client({ system: memoryAgentBenchSystemPrompt(entry.subDataset), prompt: buildMemoryAgentBenchPrompt(entry.questions[index]!, memoryTrace.context, entry.subDataset) });
          const expected = entry.answers[index] ?? [];
          const scored = scoreMemoryAgentBench(completion.text, expected, entry.subDataset);
          addTrace(report, { id, category: entry.source, subDataset: entry.subDataset, question: entry.questions[index]!, status: 'ok', answer: completion.text, expected, ...scored, latencyMs: Date.now() - started, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, memoryTrace });
        } catch (error) {
          addTrace(report, { id, category: entry.source, question: entry.questions[index]!, status: 'error', latencyMs: Date.now() - started, error: errorMessage(error) });
          options.onProgress?.(progressReport(report));
          if (isFatalModelRequestError(error)) {
            fatalError ??= error;
            options.onFatal?.(progressReport(report), error);
            throw error;
          }
          return;
        }
        options.onProgress?.(progressReport(report));
      });
    } finally { memory?.close(); }
  });
  return finishReport(report);
}

export function writeExternalArtifacts(report: ExternalRunReport, hypotheses?: Array<{ question_id: string; hypothesis: string }>): { reportPath: string; hypothesesPath?: string } {
  const stamp = Date.now();
  const dir = EXTERNAL_REPORT_DIR;
  const reportPath = join(dir, `external-${report.dataset}-${report.mode}-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  if (!hypotheses) return { reportPath };
  const hypothesesPath = join(dir, `external-${report.dataset}-${report.mode}-${stamp}.jsonl`);
  writeFileSync(hypothesesPath, `${hypotheses.map(item => JSON.stringify(item)).join('\n')}\n`);
  return { reportPath, hypothesesPath };
}

export function writeExternalCheckpoint(report: ExternalRunReport, runId: number): string {
  const dir = EXTERNAL_REPORT_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `external-inprogress-${report.dataset}-${report.mode}-${runId}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2));
  renameSync(temporary, path);
  return path;
}

export function readExternalCheckpoint(path: string): ExternalRunReport {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as ExternalRunReport;
  if (!parsed || !Array.isArray(parsed.traces) || typeof parsed.dataset !== 'string') {
    throw new Error(`invalid external checkpoint: ${path}`);
  }
  return parsed;
}

export function createCheckpointWriter(options: {
  write: (report: ExternalRunReport) => void;
  initialCases?: number;
  caseInterval?: number;
  timeIntervalMs?: number;
  now?: () => number;
}): CheckpointWriter {
  const caseInterval = options.caseInterval ?? 25;
  const timeIntervalMs = options.timeIntervalMs ?? 30_000;
  const now = options.now ?? Date.now;
  let lastCases = options.initialCases ?? 0;
  let lastWriteAt = now();
  const persist = (report: ExternalRunReport): void => {
    options.write(report);
    lastCases = report.cases;
    lastWriteAt = now();
  };
  return {
    update(report) {
      if (report.cases - lastCases >= caseInterval || now() - lastWriteAt >= timeIntervalMs) persist(report);
    },
    flush(report) {
      if (report.cases !== lastCases) persist(report);
    },
  };
}

function buildLongMemMemory(entry: LongMemEvalEntry, mode: MemoryBenchMode): ChatMemoryService {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-longmemeval-'));
  const memory = new ChatMemoryService({ dbPath: join(dir, 'memory.db'), profileId: entry.question_id, autoCapture: mode === 'hybrid', flushThresholdChars: mode === 'recent_only' ? 0 : 12000 });
  let timestamp = 0;
  for (let sessionIndex = 0; sessionIndex < entry.haystack_sessions.length; sessionIndex += 1) {
    const session = entry.haystack_sessions[sessionIndex]!;
    const sessionId = entry.haystack_session_ids[sessionIndex] ?? `session-${sessionIndex}`;
    memory.recordMessages(session.map(turn => ({ id: `${sessionId}-${timestamp + 1}`, sessionId, role: turn.role === 'assistant' ? 'bot' as const : 'owner' as const, content: turn.content, timestamp: ++timestamp })));
    memory.maybeFlush(sessionId);
  }
  const originalClose = memory.close.bind(memory);
  memory.close = () => { originalClose(); rmSync(dir, { recursive: true, force: true }); };
  return memory;
}

function buildContextMemory(context: string, mode: MemoryBenchMode, id: string, category: string): ChatMemoryService {
  const profile = process.env.MEMORY_BENCH_PROFILE === '1';
  const startedAt = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-mab-'));
  const memory = new ChatMemoryService({ dbPath: join(dir, 'memory.db'), profileId: id, autoCapture: false, flushThresholdChars: 0 });
  // MemoryAgentBench 的事实通常分布在很长的 Document 串中。使用较短片段使
  // FTS5 命中后能在固定 Prompt 预算内携带原子事实，而不是一整段无关长文。
  const chunks = chunkMemoryAgentBenchText(context, 600, category === 'Conflict_Resolution');
  if (profile) console.error(`[memory-bench-profile] chunked chars=${context.length} chunks=${chunks.length} ms=${Date.now() - startedAt}`);
  const indexingAt = Date.now();
  memory.recordMessages(chunks.map((content, index) => ({ id: `context-${index}`, sessionId: 'context', role: 'bot', content, timestamp: index + 1 })));
  if (profile) console.error(`[memory-bench-profile] indexed chunks=${chunks.length} ms=${Date.now() - indexingAt} totalMs=${Date.now() - startedAt}`);
  const originalClose = memory.close.bind(memory);
  memory.close = () => { originalClose(); rmSync(dir, { recursive: true, force: true }); };
  return memory;
}

function promptContext(memory: ChatMemoryService, question: string, mode: MemoryBenchMode): NonNullable<ExternalCaseTrace['memoryTrace']> {
  if (mode === 'full_context') {
    const messages = memory.recentMessages(100_000);
    const context = messages.map(item => item.content).join('\n');
    return { retrievalMode: mode, retrievedFactIds: [], retrievedMessageIds: messages.map(item => item.id), includedSummary: false, contextChars: context.length, context };
  }
  if (mode === 'recent_only') {
    const messages = memory.recentMessages(20);
    const context = messages.map(item => item.content).join('\n').slice(-6000);
    return { retrievalMode: mode, retrievedFactIds: [], retrievedMessageIds: messages.map(item => item.id), includedSummary: false, contextChars: context.length, context };
  }
  const built = memory.buildPromptContext(question, mode === 'fts5_only' ? 'fts5' : 'hybrid');
  return { ...built, retrievalMode: mode, contextChars: built.text.length, context: built.text };
}

export function memoryAgentBenchContextTrace(context: string, mode: 'recent_only' | 'full_context'): NonNullable<ExternalCaseTrace['memoryTrace']> {
  const chunks = chunkMemoryAgentBenchText(context, 600);
  const selected = mode === 'recent_only' ? chunks.slice(-20) : chunks;
  const text = selected.join('\n');
  const bounded = mode === 'recent_only' ? text.slice(-6000) : text;
  const firstIndex = chunks.length - selected.length;
  return {
    retrievalMode: mode,
    retrievedFactIds: [],
    retrievedMessageIds: selected.map((_, index) => `context-${firstIndex + index}`),
    includedSummary: false,
    contextChars: bounded.length,
    context: bounded,
  };
}

function buildPrompt(question: string, memoryContext: string): string {
  return `Memory:\n${memoryContext || '(no relevant memory found)'}\n\nQuestion: ${question}\n\nAnswer:`;
}

function memoryAgentBenchSystemPrompt(subDataset: string): string {
  if (subDataset.startsWith('factconsolidation_')) return FACT_CONSOLIDATION_SYSTEM_PROMPT;
  if (subDataset.startsWith('icl_')) return ICL_SYSTEM_PROMPT;
  if (subDataset.startsWith('recsys_')) return RECSYS_SYSTEM_PROMPT;
  if (subDataset.startsWith('infbench_sum_')) return SUMMARY_SYSTEM_PROMPT;
  return SYSTEM_PROMPT;
}

function buildMemoryAgentBenchPrompt(question: string, memoryContext: string, subDataset: string): string {
  const memory = memoryContext || '(no relevant memory found)';
  if (subDataset.startsWith('recsys_')) return `Memory:\n${memory}\n\nHere is the conversation:\n${question}\n\nThe recommendations are:`;
  if (subDataset.startsWith('icl_')) return `Examples:\n${memory}\n\nClassify this input using the learned numerical mapping:\n${question}\n\nLabel:`;
  if (subDataset.startsWith('factconsolidation_')) return `Knowledge pool:\n${memory}\n\nQuestion: ${question}\n\nAnswer:`;
  if (subDataset.startsWith('infbench_sum_')) return `Book memory:\n${memory}\n\nTask:\n${question}\n\nSummary:`;
  return buildPrompt(question, memory);
}

export function loadMemoryAgentBench(dir: string, category?: string): MemoryAgentBenchEntry[] {
  const files = memoryAgentBenchFiles(category);
  const script = "import json,sys,pyarrow.parquet as p; rows=p.read_table(sys.argv[1]).to_pylist(); print(json.dumps(rows, ensure_ascii=False))";
  return files.flatMap(file => {
    const full = join(dir, file);
    if (!existsSync(full)) throw new Error(`MemoryAgentBench file is missing: ${full}`);
    const result = spawnSync('python', ['-c', script, full], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`could not read ${file}: ${result.stderr.trim()}`);
    const rows = JSON.parse(result.stdout) as Array<{ context: string; questions: string[]; answers: string[][]; metadata: { qa_pair_ids?: string[]; source?: string; keypoints?: string[]; 'summary/short_keypoints'?: string[]; question_ids?: string[]; question_types?: string[] } }>;
    return rows.map(row => ({
      source: file.replace('.parquet', ''),
      subDataset: row.metadata.source ?? file.replace('.parquet', ''),
      context: row.context,
      questions: row.questions,
      answers: row.answers,
      qaPairIds: row.metadata.qa_pair_ids ?? [],
      keypoints: row.metadata.keypoints ?? row.metadata['summary/short_keypoints'] ?? [],
      questionIds: row.metadata.question_ids ?? [],
      questionTypes: row.metadata.question_types ?? [],
    }));
  });
}

export function memoryAgentBenchFiles(category?: string): string[] {
  const files = ['Accurate_Retrieval.parquet', 'Conflict_Resolution.parquet', 'Long_Range_Understanding.parquet', 'Test_Time_Learning.parquet'];
  if (!category) return files;
  return files.filter(file => file.slice(0, -'.parquet'.length) === category);
}

export function chunkMemoryAgentBenchText(text: string, maxChars: number, preserveAtomicLines = false): string[] {
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const atomicLines = (preserveAtomicLines || paragraph.length > maxChars)
      ? paragraph.split(/\n+/).map(line => line.trim()).filter(Boolean)
      : [];
    if (preserveAtomicLines && atomicLines.length > 1) {
      if (current) { chunks.push(current); current = ''; }
      for (const line of atomicLines) chunks.push(...(line.length <= maxChars ? [line] : splitOversizedText(line, maxChars)));
      continue;
    }
    // 多行 Dialogue/Fact 段落保留行作为原子边界，但仍重新装入 maxChars 窗口；
    // 直接把每行当一条消息会把 566 万字符膨胀为 5 万多个 SQLite/FTS 记录。
    const units = atomicLines.length > 1
      ? atomicLines.flatMap(line => line.length <= maxChars ? [line] : splitOversizedText(line, maxChars))
      : paragraph.length <= maxChars ? [paragraph] : splitOversizedText(paragraph, maxChars);
    for (const unit of units) {
      if (current && current.length + unit.length + 2 > maxChars) { chunks.push(current); current = ''; }
      if (unit.length > maxChars) {
        if (current) { chunks.push(current); current = ''; }
        for (let offset = 0; offset < unit.length; offset += maxChars) chunks.push(unit.slice(offset, offset + maxChars));
      } else {
        current += `${current ? '\n\n' : ''}${unit}`;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function splitOversizedText(text: string, maxChars: number): string[] {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) ?? [text];
  const units: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (current && current.length + clean.length + 1 > maxChars) { units.push(current); current = ''; }
    current += `${current ? ' ' : ''}${clean}`;
  }
  if (current) units.push(current);
  return units;
}

function validateLongMemEntry(value: unknown, index: number): LongMemEvalEntry {
  const entry = value as Partial<LongMemEvalEntry>;
  if (!entry.question_id || !entry.question || !entry.answer || !Array.isArray(entry.haystack_sessions)) throw new Error(`invalid LongMemEval entry at index ${index}`);
  return entry as LongMemEvalEntry;
}

function isJsonWhitespace(value: string): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t';
}

function newReport(dataset: ExternalDataset, mode: MemoryBenchMode, answerModel: string, endpoint: string, path: string, checksum = sha256(path)): ExternalRunReport {
  const promptMaterial = dataset === 'memoryagentbench'
    ? memoryAgentBenchPromptMaterial(mode)
    : LONGMEMEVAL_SYSTEM_PROMPT;
  return { dataset, mode, answerModel, endpoint, promptVersion: sha256Text(promptMaterial), datasetFile: path, datasetSha256: checksum, startedAt: new Date().toISOString(), completedAt: '', cases: 0, completed: 0, failed: 0, byCategory: {}, byMetric: {}, traces: [] };
}

function memoryAgentBenchPromptMaterial(mode: MemoryBenchMode): string {
  const shared = [SYSTEM_PROMPT, FACT_CONSOLIDATION_SYSTEM_PROMPT, ICL_SYSTEM_PROMPT, RECSYS_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT, 'official-metrics-v1', 'category-aware-chunking-v2', 'report-schema-v2'];
  if (mode === 'hybrid') shared.push(MEMORY_AGENT_BENCH_RETRIEVAL_PROTOCOL);
  if (mode === 'fts5_only') shared.push(MEMORY_AGENT_BENCH_FTS5_RETRIEVAL_PROTOCOL);
  return shared.join('\n');
}

export function memoryAgentBenchPromptVersion(mode: MemoryBenchMode): string {
  return sha256Text(memoryAgentBenchPromptMaterial(mode));
}

export function resumeMemoryAgentBenchReport(previous: ExternalRunReport, expected: ExternalRunReport): ExternalRunReport {
  const compatibility: Array<[string, unknown, unknown]> = [
    ['dataset', previous.dataset, expected.dataset],
    ['mode', previous.mode, expected.mode],
    ['answerModel', previous.answerModel, expected.answerModel],
    ['endpoint', canonicalEndpoint(previous.endpoint), canonicalEndpoint(expected.endpoint)],
    ['promptVersion', previous.promptVersion, expected.promptVersion],
    ['datasetSha256', previous.datasetSha256, expected.datasetSha256],
  ];
  const mismatch = compatibility.find(([, actual, wanted]) => actual !== wanted);
  if (mismatch) throw new Error(`incompatible MemoryAgentBench checkpoint: ${mismatch[0]} expected ${String(mismatch[2])}, got ${String(mismatch[1])}`);

  const report = { ...expected, startedAt: previous.startedAt || expected.startedAt };
  for (const trace of previous.traces) {
    if (trace.status === 'ok') addTrace(report, { ...trace });
  }
  return report;
}

function canonicalEndpoint(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function addTrace(report: ExternalRunReport, trace: ExternalCaseTrace): void {
  report.cases += 1;
  if (trace.status === 'ok') report.completed += 1; else report.failed += 1;
  report.traces.push(trace);
  const category = report.byCategory[trace.category] ?? { cases: 0, score: 0, scored: 0, pending: 0 };
  category.cases += 1;
  if (trace.score !== undefined) {
    category.score += trace.score;
    category.scored = (category.scored ?? 0) + 1;
  } else {
    category.pending = (category.pending ?? 0) + 1;
  }
  report.byCategory[trace.category] = category;
  if (trace.metric) {
    const metric = report.byMetric?.[trace.metric] ?? { cases: 0, score: 0, pending: 0 };
    metric.cases += 1;
    if (trace.metricStatus === 'scored' && trace.score !== undefined) metric.score += trace.score;
    else metric.pending += 1;
    (report.byMetric ??= {})[trace.metric] = metric;
  }
}

function finishReport(report: ExternalRunReport): ExternalRunReport {
  const scored = report.traces.filter(item => item.score !== undefined);
  const metricNames = new Set(scored.map(item => item.metric ?? 'legacy'));
  report.score = scored.length && metricNames.size === 1 ? scored.reduce((sum, item) => sum + item.score!, 0) / scored.length : undefined;
  for (const category of Object.values(report.byCategory)) category.score = category.scored ? category.score / category.scored : 0;
  for (const metric of Object.values(report.byMetric ?? {})) metric.score = metric.cases > metric.pending ? metric.score / (metric.cases - metric.pending) : 0;
  report.completedAt = new Date().toISOString();
  return report;
}

function progressReport(report: ExternalRunReport): ExternalRunReport {
  return {
    ...report,
    completedAt: new Date().toISOString(),
    byCategory: Object.fromEntries(Object.entries(report.byCategory).map(([key, value]) => [key, { ...value }])),
    byMetric: Object.fromEntries(Object.entries(report.byMetric ?? {}).map(([key, value]) => [key, { ...value }])),
    traces: [...report.traces],
  };
}

export function scoreMemoryAgentBench(answer: string, expected: string[], subDataset: string): Pick<ExternalCaseTrace, 'score' | 'metric' | 'metricStatus' | 'metrics'> {
  if (subDataset.startsWith('infbench_sum_')) return { metric: 'llm_judge_f1', metricStatus: 'judge_pending' };
  if (subDataset.startsWith('longmemeval_')) return { metric: 'llm_as_judge', metricStatus: 'judge_pending' };
  if (subDataset.startsWith('recsys_')) {
    const recalls = recommendationRecall(answer, expected);
    return { score: recalls.recallAt5, metric: 'Recall@5', metricStatus: 'scored', metrics: { 'Recall@1': recalls.recallAt1, 'Recall@5': recalls.recallAt5, 'Recall@10': recalls.recallAt10 } };
  }
  if (subDataset.startsWith('icl_') || subDataset.startsWith('detective_')) {
    const score = expected.some(item => normalizeBenchmarkAnswer(answer) === normalizeBenchmarkAnswer(item)) ? 1 : 0;
    return { score, metric: 'exact_match', metricStatus: 'scored' };
  }
  if (subDataset.startsWith('eventqa_')) {
    const normalized = normalizeBenchmarkAnswer(answer);
    const score = expected.length > 0 && expected.every(item => normalized.includes(normalizeBenchmarkAnswer(item))) ? 1 : 0;
    return { score, metric: 'eventqa_recall', metricStatus: 'scored' };
  }
  const normalized = normalizeBenchmarkAnswer(answer);
  const score = expected.length > 0 && expected.some(item => normalized.includes(normalizeBenchmarkAnswer(item))) ? 1 : 0;
  return { score, metric: 'substring_exact_match', metricStatus: 'scored' };
}

let movieNamesById: Map<string, string> | undefined;
function recommendationRecall(answer: string, expected: string[]): { recallAt1: number; recallAt5: number; recallAt10: number } {
  if (!movieNamesById) {
    const mapping = JSON.parse(readFileSync(join(ROOT, 'memory-agent-bench-data', 'entity2id.json'), 'utf8')) as Record<string, number>;
    movieNamesById = new Map(Object.entries(mapping).map(([uri, id]) => [String(id), normalizeMovieName(uri)]));
  }
  const groundTruth = expected.map(id => movieNamesById!.get(String(id).trim())).filter((name): name is string => Boolean(name));
  if (groundTruth.length === 0) return { recallAt1: 0, recallAt5: 0, recallAt10: 0 };
  const predicted = answer.split(/\r?\n|,/).map(normalizeMovieName).filter(Boolean);
  const recallAt = (limit: number) => groundTruth.filter(name => predicted.slice(0, limit).some(candidate => candidate === name || candidate.includes(name) || name.includes(candidate))).length / groundTruth.length;
  return { recallAt1: recallAt(1), recallAt5: recallAt(5), recallAt10: recallAt(10) };
}

function normalizeMovieName(value: string): string {
  const filename = value.split('/').at(-1) ?? value;
  return filename.replace(/[<>]/g, '').replace(/_/g, ' ').replace(/^\s*\d+[.)、]?\s*/, '').replace(/\([^()]*\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLocaleLowerCase();
}

function normalizeBenchmarkAnswer(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\b(?:a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function directorySha256(dir: string): string {
  const names = ['Accurate_Retrieval.parquet', 'Conflict_Resolution.parquet', 'Long_Range_Understanding.parquet', 'Test_Time_Learning.parquet'];
  return createHash('sha256').update(names.map(name => sha256(join(dir, name))).join('')).digest('hex');
}

function benchmarkConcurrency(): number {
  const value = Number.parseInt(process.env.MEMORY_BENCH_CONCURRENCY ?? '8', 10);
  return Number.isInteger(value) && value > 0 && value <= 32 ? value : 8;
}

function parseTimeout(value: string | undefined): number {
  const timeout = Number.parseInt(value ?? '60000', 10);
  return Number.isInteger(timeout) && timeout >= 1000 && timeout <= 300000 ? timeout : 60000;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mapLimited<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && firstError === undefined) {
      const item = items[next++];
      if (item === undefined) continue;
      try { await run(item); }
      catch (error) { firstError ??= error; }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

async function* limitAsync<T>(items: AsyncIterable<T>, limit?: number): AsyncGenerator<T> {
  const iterator = items[Symbol.asyncIterator]();
  let count = 0;
  try {
    while (limit === undefined || count < limit) {
      const next = await iterator.next();
      if (next.done) return;
      count += 1;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

async function mapAsyncLimited<T>(items: AsyncIterable<T>, concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  const active = new Set<Promise<void>>();
  const size = Math.max(1, concurrency);
  let firstError: unknown;
  for await (const item of items) {
    if (firstError !== undefined) break;
    const task = Promise.resolve().then(() => run(item)).catch(error => { firstError ??= error; });
    active.add(task);
    void task.then(() => active.delete(task));
    if (active.size >= size) await Promise.race(active);
  }
  await Promise.all(active);
  if (firstError !== undefined) throw firstError;
}

function sha256Text(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
