import { isFatalModelRequestError, type CompletionClient, type ExternalCaseTrace, type FatalModelRequestError, type MemoryAgentBenchEntry } from './external.js';

export interface LongMemJudgeReference {
  id: string;
  questionId: string;
  questionType: string;
  question: string;
  expected: string;
}

export interface LongMemJudgeTrace {
  id: string;
  sourceQuestion?: string;
  questionId: string;
  questionType: string;
  status: 'ok' | 'error';
  label?: boolean;
  judgeResponse?: string;
  error?: string;
}

export interface LongMemJudgeReport {
  schemaVersion: 'mineclaw-memoryagentbench-longmem-judge/v1';
  protocol: 'MemoryAgentBench longmem_qa_evaluate.py compatible';
  officialJudgeModel: 'gpt-4o';
  judgeModel: string;
  endpoint: string;
  officialModelMatched: boolean;
  sourceReport: string;
  startedAt: string;
  completedAt: string;
  cases: number;
  completed: number;
  failed: number;
  accuracy: number;
  byQuestionType: Record<string, { cases: number; correct: number; accuracy: number }>;
  traces: LongMemJudgeTrace[];
}

export function longMemReferences(entries: MemoryAgentBenchEntry[]): Map<string, LongMemJudgeReference> {
  const references = new Map<string, LongMemJudgeReference>();
  for (const entry of entries.filter(item => item.subDataset.startsWith('longmemeval_'))) {
    for (let index = 0; index < entry.questions.length; index += 1) {
      const id = entry.qaPairIds[index] ?? `${entry.source}-${index}`;
      const question = entry.questions[index] ?? '';
      const key = longMemJudgeSourceKey(id, question);
      if (references.has(key)) throw new Error(`duplicate MAB LongMem Judge source identity: ${id}`);
      references.set(key, {
        id,
        questionId: entry.questionIds?.[index] ?? id,
        questionType: entry.questionTypes?.[index] ?? 'unknown',
        question,
        expected: entry.answers[index]?.[0] ?? '',
      });
    }
  }
  return references;
}

export function longMemJudgeSourceKey(id: string, question: string): string {
  return `${id}\u0000${question}`;
}

export function longMemJudgePrompt(reference: LongMemJudgeReference, response: string): string {
  const { questionType, question, expected, questionId } = reference;
  if (questionId.includes('_abs')) {
    return `Question (known to be unanswerable): ${question}\nReference explanation: ${expected}\nModel response: ${response}\nDid the model correctly identify that the answer is unavailable or insufficiently supported? Answer yes or no only.`;
  }
  if (questionType === 'single-session-preference') {
    return `Question: ${question}\nDesired personalization rubric: ${expected}\nModel response: ${response}\nDoes the response correctly recall and use relevant personal information? It need not cover every rubric point. Answer yes or no only.`;
  }
  const extra = questionType === 'temporal-reasoning'
    ? 'For durations, accept an off-by-one difference.'
    : questionType === 'knowledge-update'
      ? 'If both old and updated information appear, accept the response when the required updated answer is present.'
      : 'Equivalent wording and complete intermediate reasoning are acceptable; a response containing only part of a multi-part answer is not.';
  return `Question: ${question}\nCorrect answer: ${expected}\nModel response: ${response}\n${extra}\nIs the model response correct? Answer yes or no only.`;
}

export async function judgeLongMemCase(options: {
  trace: ExternalCaseTrace;
  reference: LongMemJudgeReference;
  client: CompletionClient;
}): Promise<LongMemJudgeTrace> {
  const { trace, reference, client } = options;
  if (trace.status !== 'ok' || !trace.answer) {
    return { id: trace.id, sourceQuestion: trace.question, questionId: reference.questionId, questionType: reference.questionType, status: 'error', error: 'source trace has no successful answer' };
  }
  if (!reference.question || !reference.expected || reference.questionType === 'unknown') {
    return { id: trace.id, sourceQuestion: trace.question, questionId: reference.questionId, questionType: reference.questionType, status: 'error', error: 'reference metadata is incomplete' };
  }
  try {
    const completion = await client({
      system: 'Judge the supplied answer strictly according to the rubric. Return yes or no only.',
      prompt: longMemJudgePrompt(reference, trace.answer),
    });
    return {
      id: trace.id,
      sourceQuestion: trace.question,
      questionId: reference.questionId,
      questionType: reference.questionType,
      status: 'ok',
      label: /\byes\b/i.test(completion.text),
      judgeResponse: completion.text,
    };
  } catch (error) {
    if (isFatalModelRequestError(error)) throw error;
    return {
      id: trace.id,
      sourceQuestion: trace.question,
      questionId: reference.questionId,
      questionType: reference.questionType,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runLongMemJudge(options: {
  sourceReport: string;
  sourceTraces: ExternalCaseTrace[];
  references: Map<string, LongMemJudgeReference>;
  client: CompletionClient;
  judgeModel: string;
  endpoint: string;
  concurrency?: number;
  initialTraces?: LongMemJudgeTrace[];
  onProgress?: (report: LongMemJudgeReport) => void;
  onFatal?: (report: LongMemJudgeReport, error: FatalModelRequestError) => void;
}): Promise<LongMemJudgeReport> {
  const startedAt = new Date().toISOString();
  const candidates = options.sourceTraces.filter(trace => trace.metric === 'llm_as_judge' && trace.metricStatus === 'judge_pending');
  const candidateKeys = candidates.map(trace => longMemJudgeSourceKey(trace.id, trace.question));
  if (new Set(candidateKeys).size !== candidateKeys.length) throw new Error('duplicate MAB LongMem Judge composite source identity');
  const questionsById = new Map<string, string[]>();
  for (const trace of candidates) questionsById.set(trace.id, [...(questionsById.get(trace.id) ?? []), trace.question]);
  const results = new Map<string, LongMemJudgeTrace>();
  for (const trace of options.initialTraces ?? []) {
    const sourceQuestion = trace.sourceQuestion ?? uniqueLegacyQuestion(trace.id, questionsById);
    results.set(longMemJudgeSourceKey(trace.id, sourceQuestion), { ...trace, sourceQuestion });
  }
  const pending = candidates.filter(trace => results.get(longMemJudgeSourceKey(trace.id, trace.question))?.status !== 'ok');
  let cursor = 0;
  let fatalError: FatalModelRequestError | undefined;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!fatalError && cursor < pending.length) {
      const trace = pending[cursor++]!;
      const sourceKey = longMemJudgeSourceKey(trace.id, trace.question);
      const reference = options.references.get(sourceKey);
      let result: LongMemJudgeTrace;
      try {
        result = reference
          ? await judgeLongMemCase({ trace, reference, client: options.client })
          : { id: trace.id, sourceQuestion: trace.question, questionId: trace.id, questionType: 'unknown', status: 'error', error: 'reference_not_found' };
      } catch (error) {
        if (!isFatalModelRequestError(error)) throw error;
        result = { id: trace.id, sourceQuestion: trace.question, questionId: reference?.questionId ?? trace.id, questionType: reference?.questionType ?? 'unknown', status: 'error', error: error.message };
        results.set(sourceKey, result);
        const partial = buildLongMemJudgeReport(options, candidates, results, startedAt, '');
        options.onProgress?.(partial);
        if (!fatalError) {
          fatalError = error;
          options.onFatal?.(partial, error);
        }
        break;
      }
      results.set(sourceKey, result);
      options.onProgress?.(buildLongMemJudgeReport(options, candidates, results, startedAt, ''));
    }
  }));
  if (fatalError) throw fatalError;
  return buildLongMemJudgeReport(options, candidates, results, startedAt, new Date().toISOString());
}

function buildLongMemJudgeReport(
  options: Pick<Parameters<typeof runLongMemJudge>[0], 'sourceReport' | 'judgeModel' | 'endpoint'>,
  candidates: ExternalCaseTrace[],
  results: Map<string, LongMemJudgeTrace>,
  startedAt: string,
  completedAt: string,
): LongMemJudgeReport {
  const traces = candidates.map(trace => results.get(longMemJudgeSourceKey(trace.id, trace.question))).filter((trace): trace is LongMemJudgeTrace => Boolean(trace));
  const successful = traces.filter((trace): trace is LongMemJudgeTrace & { label: boolean } => trace.status === 'ok' && trace.label !== undefined);
  const byQuestionType: LongMemJudgeReport['byQuestionType'] = {};
  for (const trace of successful) {
    const aggregate = byQuestionType[trace.questionType] ?? { cases: 0, correct: 0, accuracy: 0 };
    aggregate.cases += 1;
    if (trace.label) aggregate.correct += 1;
    aggregate.accuracy = aggregate.correct / aggregate.cases;
    byQuestionType[trace.questionType] = aggregate;
  }
  const correct = successful.filter(trace => trace.label).length;
  return {
    schemaVersion: 'mineclaw-memoryagentbench-longmem-judge/v1',
    protocol: 'MemoryAgentBench longmem_qa_evaluate.py compatible',
    officialJudgeModel: 'gpt-4o',
    judgeModel: options.judgeModel,
    endpoint: options.endpoint,
    officialModelMatched: options.judgeModel === 'gpt-4o',
    sourceReport: options.sourceReport,
    startedAt,
    completedAt,
    cases: candidates.length,
    completed: successful.length,
    failed: traces.filter(trace => trace.status === 'error').length,
    accuracy: successful.length > 0 ? correct / successful.length : 0,
    byQuestionType,
    traces,
  };
}

function uniqueLegacyQuestion(id: string, questionsById: Map<string, string[]>): string {
  const questions = questionsById.get(id) ?? [];
  if (questions.length !== 1) throw new Error(`incompatible MAB LongMem Judge checkpoint: duplicate id ${id} lacks sourceQuestion`);
  return questions[0]!;
}
