import { isFatalModelRequestError, type CompletionClient, type ExternalCaseTrace, type FatalModelRequestError, type MemoryAgentBenchEntry } from './external.js';

export interface SummaryReference {
  id: string;
  keypoints: string[];
  expertSummary: string;
}

export interface SummaryJudgeTrace {
  id: string;
  status: 'ok' | 'error';
  fluency?: number;
  recallFound?: number;
  recallTotal?: number;
  precisionFound?: number;
  precisionTotal?: number;
  recall?: number;
  precision?: number;
  f1?: number;
  fluencyOutput?: string;
  recallOutput?: string;
  precisionOutput?: string;
  error?: string;
}

export interface SummaryJudgeReport {
  schemaVersion: 'mineclaw-memoryagentbench-summary-judge/v1';
  protocol: 'MemoryAgentBench summarization_evaluate.py compatible';
  officialJudgeModel: 'gpt-4o-2024-05-13';
  judgeModel: string;
  endpoint: string;
  officialModelMatched: boolean;
  sourceReport: string;
  startedAt: string;
  completedAt: string;
  cases: number;
  completed: number;
  failed: number;
  averages: {
    fluency: number;
    recall: number;
    precision: number;
    f1: number;
  };
  traces: SummaryJudgeTrace[];
}

interface JudgeJson {
  fluency?: number;
  recall?: number;
  precision?: number;
  sentence_count?: number;
}

export function summaryReferences(entries: MemoryAgentBenchEntry[]): Map<string, SummaryReference> {
  const references = new Map<string, SummaryReference>();
  for (const entry of entries) {
    for (let index = 0; index < entry.questions.length; index += 1) {
      const id = entry.qaPairIds[index] ?? `${entry.source}-${index}`;
      references.set(id, {
        id,
        keypoints: [...entry.keypoints],
        expertSummary: entry.answers[index]?.[0] ?? '',
      });
    }
  }
  return references;
}

export function parseJudgeJson(text: string): JudgeJson {
  const candidates = text.match(/\{[^{}]*\}/gs) ?? [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]!) as JudgeJson;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Judge 有时在最终 JSON 前输出 reasoning，继续尝试更早的对象。
    }
  }
  throw new Error(`judge response has no valid JSON object: ${text.slice(0, 240)}`);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`judge response has invalid ${field}`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scoreSummaryJudge(input: {
  fluency: number;
  recallFound: number;
  recallTotal: number;
  precisionFound: number;
  precisionTotal: number;
}): Pick<SummaryJudgeTrace, 'fluency' | 'recallFound' | 'recallTotal' | 'precisionFound' | 'precisionTotal' | 'recall' | 'precision' | 'f1'> {
  const fluency = clamp(input.fluency, 0, 1);
  const recallTotal = Math.max(0, Math.floor(input.recallTotal));
  const precisionTotal = Math.max(0, Math.floor(input.precisionTotal));
  const recallFound = clamp(Math.floor(input.recallFound), 0, recallTotal);
  const precisionFound = clamp(Math.floor(input.precisionFound), 0, precisionTotal);
  const recall = recallTotal > 0 ? recallFound / recallTotal : 0;
  const precision = precisionTotal > 0 ? precisionFound / precisionTotal : 0;
  const f1 = recall + precision > 0 ? fluency * 2 * recall * precision / (recall + precision) : 0;
  return { fluency, recallFound, recallTotal, precisionFound, precisionTotal, recall, precision, f1 };
}

export async function judgeSummaryCase(options: {
  trace: ExternalCaseTrace;
  reference: SummaryReference;
  client: CompletionClient;
}): Promise<SummaryJudgeTrace> {
  const { trace, reference, client } = options;
  if (trace.status !== 'ok' || !trace.answer) return { id: trace.id, status: 'error', error: 'source trace has no successful answer' };
  if (reference.keypoints.length === 0) return { id: trace.id, status: 'error', error: 'reference has no keypoints' };
  if (!reference.expertSummary) return { id: trace.id, status: 'error', error: 'reference has no expert summary' };
  try {
    const system = 'You are an impartial evaluation judge. Follow the rubric exactly and end with only the requested JSON object.';
    const [fluencyCompletion, recallCompletion, precisionCompletion] = await Promise.all([
      client({ system, prompt: fluencyPrompt(trace.answer) }),
      client({ system, prompt: recallPrompt(reference.keypoints, trace.answer) }),
      client({ system, prompt: precisionPrompt(reference.expertSummary, trace.answer) }),
    ]);
    const fluencyJson = parseJudgeJson(fluencyCompletion.text);
    const recallJson = parseJudgeJson(recallCompletion.text);
    const precisionJson = parseJudgeJson(precisionCompletion.text);
    const scored = scoreSummaryJudge({
      fluency: finiteNumber(fluencyJson.fluency, 'fluency'),
      recallFound: finiteNumber(recallJson.recall, 'recall'),
      recallTotal: reference.keypoints.length,
      precisionFound: finiteNumber(precisionJson.precision, 'precision'),
      precisionTotal: finiteNumber(precisionJson.sentence_count, 'sentence_count'),
    });
    return {
      id: trace.id,
      status: 'ok',
      ...scored,
      fluencyOutput: fluencyCompletion.text,
      recallOutput: recallCompletion.text,
      precisionOutput: precisionCompletion.text,
    };
  } catch (error) {
    if (isFatalModelRequestError(error)) throw error;
    return { id: trace.id, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSummaryJudge(options: {
  sourceReport: string;
  sourceTraces: ExternalCaseTrace[];
  references: Map<string, SummaryReference>;
  client: CompletionClient;
  judgeModel: string;
  endpoint: string;
  concurrency?: number;
  initialTraces?: SummaryJudgeTrace[];
  onProgress?: (report: SummaryJudgeReport) => void;
  onFatal?: (report: SummaryJudgeReport, error: FatalModelRequestError) => void;
}): Promise<SummaryJudgeReport> {
  const startedAt = new Date().toISOString();
  const candidates = options.sourceTraces.filter(trace => trace.metric === 'llm_judge_f1' && trace.metricStatus === 'judge_pending');
  const completed = new Map((options.initialTraces ?? []).filter(trace => trace.status === 'ok').map(trace => [trace.id, trace]));
  const results = new Map((options.initialTraces ?? []).map(trace => [trace.id, trace]));
  const pending = candidates.filter(trace => !completed.has(trace.id));
  let cursor = 0;
  let fatalError: FatalModelRequestError | undefined;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!fatalError && cursor < pending.length) {
      const trace = pending[cursor++]!;
      const reference = options.references.get(trace.id);
      let result: SummaryJudgeTrace;
      try {
        result = reference
          ? await judgeSummaryCase({ trace, reference, client: options.client })
          : { id: trace.id, status: 'error', error: 'reference_not_found' };
      } catch (error) {
        if (!isFatalModelRequestError(error)) throw error;
        result = { id: trace.id, status: 'error', error: error.message };
        results.set(trace.id, result);
        const partial = buildReport(options, candidates, results, startedAt, '');
        options.onProgress?.(partial);
        if (!fatalError) {
          fatalError = error;
          options.onFatal?.(partial, error);
        }
        break;
      }
      results.set(trace.id, result);
      options.onProgress?.(buildReport(options, candidates, results, startedAt, ''));
    }
  }));
  if (fatalError) throw fatalError;
  return buildReport(options, candidates, results, startedAt, new Date().toISOString());
}

function buildReport(
  options: Pick<Parameters<typeof runSummaryJudge>[0], 'sourceReport' | 'judgeModel' | 'endpoint'>,
  candidates: ExternalCaseTrace[],
  results: Map<string, SummaryJudgeTrace>,
  startedAt: string,
  completedAt: string,
): SummaryJudgeReport {
  const traces = candidates.map(trace => results.get(trace.id)).filter((trace): trace is SummaryJudgeTrace => Boolean(trace));
  const successful = traces.filter((trace): trace is SummaryJudgeTrace & Required<Pick<SummaryJudgeTrace, 'fluency' | 'recall' | 'precision' | 'f1'>> => trace.status === 'ok' && trace.f1 !== undefined && trace.recall !== undefined && trace.precision !== undefined && trace.fluency !== undefined);
  const average = (field: 'fluency' | 'recall' | 'precision' | 'f1') => successful.length > 0
    ? successful.reduce((sum, trace) => sum + trace[field], 0) / successful.length
    : 0;
  return {
    schemaVersion: 'mineclaw-memoryagentbench-summary-judge/v1',
    protocol: 'MemoryAgentBench summarization_evaluate.py compatible',
    officialJudgeModel: 'gpt-4o-2024-05-13',
    judgeModel: options.judgeModel,
    endpoint: options.endpoint,
    officialModelMatched: options.judgeModel === 'gpt-4o-2024-05-13',
    sourceReport: options.sourceReport,
    startedAt,
    completedAt,
    cases: candidates.length,
    completed: successful.length,
    failed: traces.filter(trace => trace.status === 'error').length,
    averages: { fluency: average('fluency'), recall: average('recall'), precision: average('precision'), f1: average('f1') },
    traces,
  };
}

function fluencyPrompt(summary: string): string {
  return `Evaluate the fluency of the summary. Score 0 if it is incoherent, repetitive, gibberish, or materially incomplete. Score 1 if it is coherent, non-repetitive, fluent, and grammatically correct; a truncated final sentence alone may still score 1.\n\nSummary:\n${summary}\n\nReturn JSON: {"fluency": 1}`;
}

function recallPrompt(keypoints: string[], summary: string): string {
  const numbered = keypoints.map((point, index) => `${index + 1}. ${point}`).join('\n');
  return `Evaluate recall for a novel summary. Count how many key points are factually supported by the summary. Do not award a point for unsupported or merely related content.\n\nKey points:\n${numbered}\n\nSummary:\n${summary}\n\nReturn JSON with the supported indices and count: {"supported_key_points": [1], "recall": 1}`;
}

function precisionPrompt(expertSummary: string, summary: string): string {
  return `Evaluate precision for a novel summary. Split the provided summary into sentences. Count a sentence as supported when its major facts align with the expert summary; minor name, date, or location details may be absent. A sentence is unsupported if contradicted or if it introduces analysis or facts absent from the expert summary.\n\nExpert summary:\n${expertSummary}\n\nProvided summary:\n${summary}\n\nReturn JSON: {"precision": 2, "sentence_count": 3}`;
}
