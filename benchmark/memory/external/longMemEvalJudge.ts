import {
  isFatalModelRequestError,
  type CompletionClient,
  type FatalModelRequestError,
  type LongMemEvalJudgeReference,
} from './external.js';
import { LONGMEMEVAL_JUDGE_SYSTEM_PROMPT, longMemEvalJudgePrompt } from './longMemJudgeRubric.js';

export interface LongMemEvalHypothesis {
  question_id: string;
  hypothesis: string;
}

export interface LongMemEvalJudgeTrace {
  questionId: string;
  category: string;
  status: 'ok' | 'error';
  label?: boolean;
  judgeResponse?: string;
  error?: string;
}

export interface LongMemEvalJudgeReport {
  schemaVersion: 'mineclaw-longmemeval-judge/v1';
  dataset: 'longmemeval_s' | 'longmemeval_m' | 'longmemeval_oracle';
  evaluator: 'LongMemEval official rubric adapted to OpenAI-compatible API';
  judgeModel: string;
  endpoint: string;
  referenceFile: string;
  referenceSha256: string;
  hypothesesFile: string;
  hypothesesSha256: string;
  startedAt: string;
  completedAt: string;
  cases: number;
  completed: number;
  failed: number;
  accuracy: number;
  abstentionAccuracy: number;
  byCategory: Record<string, { cases: number; correct: number; accuracy: number }>;
  traces: LongMemEvalJudgeTrace[];
}

export function assertLongMemEvalJudgeResumeCompatible(
  previous: Partial<LongMemEvalJudgeReport>,
  expected: Pick<LongMemEvalJudgeReport, 'dataset' | 'judgeModel' | 'endpoint' | 'referenceSha256' | 'hypothesesSha256'>,
): void {
  const canonicalEndpoint = (value: string | undefined) => (value ?? '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  const checks: Array<[string, unknown, unknown]> = [
    ['dataset', previous.dataset, expected.dataset],
    ['judgeModel', previous.judgeModel, expected.judgeModel],
    ['endpoint', canonicalEndpoint(previous.endpoint), canonicalEndpoint(expected.endpoint)],
    ['referenceSha256', previous.referenceSha256, expected.referenceSha256],
    ['hypothesesSha256', previous.hypothesesSha256, expected.hypothesesSha256],
  ];
  const mismatch = checks.find(([, actual, wanted]) => actual !== wanted);
  if (mismatch) throw new Error(`incompatible LongMemEval Judge checkpoint: ${mismatch[0]} expected ${String(mismatch[2])}, got ${String(mismatch[1])}`);
}

export async function runLongMemEvalJudge(options: {
  dataset: LongMemEvalJudgeReport['dataset'];
  judgeModel: string;
  endpoint: string;
  referenceFile: string;
  referenceSha256: string;
  hypothesesFile: string;
  hypothesesSha256: string;
  hypotheses: LongMemEvalHypothesis[];
  references: Map<string, LongMemEvalJudgeReference>;
  client: CompletionClient;
  concurrency?: number;
  initialTraces?: LongMemEvalJudgeTrace[];
  onProgress?: (report: LongMemEvalJudgeReport) => void;
  onFatal?: (report: LongMemEvalJudgeReport, error: FatalModelRequestError) => void;
}): Promise<LongMemEvalJudgeReport> {
  const startedAt = new Date().toISOString();
  const successfulIds = new Set((options.initialTraces ?? []).filter(trace => trace.status === 'ok').map(trace => trace.questionId));
  const results = new Map((options.initialTraces ?? []).map(trace => [trace.questionId, trace]));
  const pending = options.hypotheses.filter(item => !successfulIds.has(item.question_id));
  let cursor = 0;
  let fatalError: FatalModelRequestError | undefined;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!fatalError && cursor < pending.length) {
      const hypothesis = pending[cursor++]!;
      const reference = options.references.get(hypothesis.question_id);
      let result: LongMemEvalJudgeTrace;
      if (!reference) {
        result = { questionId: hypothesis.question_id, category: 'unknown', status: 'error', error: 'reference_not_found' };
      } else {
        try {
          const completion = await options.client({
            system: LONGMEMEVAL_JUDGE_SYSTEM_PROMPT,
            prompt: longMemEvalJudgePrompt(reference.question_type, reference.question, reference.answer, hypothesis.hypothesis, hypothesis.question_id.endsWith('_abs')),
          });
          result = {
            questionId: hypothesis.question_id,
            category: reference.question_type,
            status: 'ok',
            label: /^yes\b/i.test(completion.text.trim()),
            judgeResponse: completion.text,
          };
        } catch (error) {
          result = {
            questionId: hypothesis.question_id,
            category: reference.question_type,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          };
          results.set(hypothesis.question_id, result);
          const partial = buildLongMemEvalJudgeReport(options, results, startedAt, '');
          options.onProgress?.(partial);
          if (isFatalModelRequestError(error)) {
            if (!fatalError) {
              fatalError = error;
              options.onFatal?.(partial, error);
            }
            break;
          }
          continue;
        }
      }
      results.set(hypothesis.question_id, result);
      options.onProgress?.(buildLongMemEvalJudgeReport(options, results, startedAt, ''));
    }
  }));

  if (fatalError) throw fatalError;
  return buildLongMemEvalJudgeReport(options, results, startedAt, new Date().toISOString());
}

function buildLongMemEvalJudgeReport(
  options: Pick<Parameters<typeof runLongMemEvalJudge>[0], 'dataset' | 'judgeModel' | 'endpoint' | 'referenceFile' | 'referenceSha256' | 'hypothesesFile' | 'hypothesesSha256' | 'hypotheses'>,
  results: Map<string, LongMemEvalJudgeTrace>,
  startedAt: string,
  completedAt: string,
): LongMemEvalJudgeReport {
  const traces = options.hypotheses.map(item => results.get(item.question_id)).filter((trace): trace is LongMemEvalJudgeTrace => Boolean(trace));
  const successful = traces.filter((trace): trace is LongMemEvalJudgeTrace & { label: boolean } => trace.status === 'ok' && trace.label !== undefined);
  const byCategory: LongMemEvalJudgeReport['byCategory'] = {};
  for (const trace of successful) {
    const aggregate = byCategory[trace.category] ?? { cases: 0, correct: 0, accuracy: 0 };
    aggregate.cases += 1;
    if (trace.label) aggregate.correct += 1;
    aggregate.accuracy = aggregate.correct / aggregate.cases;
    byCategory[trace.category] = aggregate;
  }
  const abstention = successful.filter(trace => trace.questionId.endsWith('_abs'));
  return {
    schemaVersion: 'mineclaw-longmemeval-judge/v1',
    dataset: options.dataset,
    evaluator: 'LongMemEval official rubric adapted to OpenAI-compatible API',
    judgeModel: options.judgeModel,
    endpoint: options.endpoint,
    referenceFile: options.referenceFile,
    referenceSha256: options.referenceSha256,
    hypothesesFile: options.hypothesesFile,
    hypothesesSha256: options.hypothesesSha256,
    startedAt,
    completedAt,
    cases: options.hypotheses.length,
    completed: successful.length,
    failed: traces.filter(trace => trace.status === 'error').length,
    accuracy: successful.length > 0 ? successful.filter(trace => trace.label).length / successful.length : 0,
    abstentionAccuracy: abstention.length > 0 ? abstention.filter(trace => trace.label).length / abstention.length : 0,
    byCategory,
    traces,
  };
}
