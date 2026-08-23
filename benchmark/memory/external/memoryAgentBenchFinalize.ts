import { resolve } from 'node:path';
import type { ExternalCaseTrace, ExternalRunReport } from './external.js';
import { longMemJudgeSourceKey, type LongMemJudgeReport } from './memoryAgentBenchLongMemJudge.js';
import type { SummaryJudgeReport } from './memoryAgentBenchSummaryJudge.js';

export interface FinalizedMemoryAgentBenchReport extends ExternalRunReport {
  judgeEvaluation: {
    finalizedAt: string;
    summaryJudgeReport: string;
    longMemJudgeReport: string;
    summaryJudgeModel: string;
    longMemJudgeModel: string;
    officialModelsMatched: boolean;
  };
}

export function finalizeMemoryAgentBench(options: {
  source: ExternalRunReport;
  sourceReportPath: string;
  summaryJudge: SummaryJudgeReport;
  summaryJudgeReportPath: string;
  longMemJudge: LongMemJudgeReport;
  longMemJudgeReportPath: string;
}): FinalizedMemoryAgentBenchReport {
  if (options.source.dataset !== 'memoryagentbench') throw new Error('source must be a MemoryAgentBench report');
  assertJudgeSource(options.sourceReportPath, options.summaryJudge.sourceReport, 'summary');
  assertJudgeSource(options.sourceReportPath, options.longMemJudge.sourceReport, 'longmem');
  const summaryPending = options.source.traces.filter(trace => trace.metric === 'llm_judge_f1' && trace.metricStatus === 'judge_pending');
  const longMemPending = options.source.traces.filter(trace => trace.metric === 'llm_as_judge' && trace.metricStatus === 'judge_pending');
  assertCompleteJudge('summary', summaryPending.length, options.summaryJudge.cases, options.summaryJudge.completed, options.summaryJudge.failed);
  assertCompleteJudge('longmem', longMemPending.length, options.longMemJudge.cases, options.longMemJudge.completed, options.longMemJudge.failed);
  const summaryById = new Map(options.summaryJudge.traces.map(trace => [trace.id, trace]));
  const longMemById = buildLongMemJudgeIndex(longMemPending, options.longMemJudge.traces);
  const traces = options.source.traces.map(trace => finalizeTrace(trace, summaryById, longMemById));
  if (traces.some(trace => trace.metricStatus === 'judge_pending')) throw new Error('finalized report still contains judge_pending traces');
  const report = rebuildAggregates({ ...options.source, traces });
  return {
    ...report,
    judgeEvaluation: {
      finalizedAt: report.completedAt,
      summaryJudgeReport: resolve(options.summaryJudgeReportPath),
      longMemJudgeReport: resolve(options.longMemJudgeReportPath),
      summaryJudgeModel: options.summaryJudge.judgeModel,
      longMemJudgeModel: options.longMemJudge.judgeModel,
      officialModelsMatched: options.summaryJudge.officialModelMatched && options.longMemJudge.officialModelMatched,
    },
  };
}

function buildLongMemJudgeIndex(
  pending: ExternalCaseTrace[],
  judged: LongMemJudgeReport['traces'],
): Map<string, LongMemJudgeReport['traces'][number]> {
  const questionsById = new Map<string, string[]>();
  for (const trace of pending) questionsById.set(trace.id, [...(questionsById.get(trace.id) ?? []), trace.question]);
  const index = new Map<string, LongMemJudgeReport['traces'][number]>();
  for (const trace of judged) {
    const questions = questionsById.get(trace.id) ?? [];
    const sourceQuestion = trace.sourceQuestion ?? (questions.length === 1 ? questions[0] : undefined);
    if (!sourceQuestion) throw new Error(`longmem judge result has ambiguous duplicate id without sourceQuestion: ${trace.id}`);
    const key = longMemJudgeSourceKey(trace.id, sourceQuestion);
    if (index.has(key)) throw new Error(`duplicate longmem judge result: ${trace.id}`);
    index.set(key, trace);
  }
  return index;
}

function assertJudgeSource(sourcePath: string, judgeSourcePath: string, kind: string): void {
  if (resolve(sourcePath) !== resolve(judgeSourcePath)) throw new Error(`${kind} judge sourceReport mismatch`);
}

function assertCompleteJudge(kind: string, expected: number, cases: number, completed: number, failed: number): void {
  if (cases !== expected || completed !== expected || failed !== 0) {
    throw new Error(`${kind} judge is incomplete: expected=${expected} cases=${cases} completed=${completed} failed=${failed}`);
  }
}

function finalizeTrace(
  trace: ExternalCaseTrace,
  summaryById: Map<string, SummaryJudgeReport['traces'][number]>,
  longMemById: Map<string, LongMemJudgeReport['traces'][number]>,
): ExternalCaseTrace {
  if (trace.metricStatus !== 'judge_pending') return { ...trace };
  if (trace.metric === 'llm_judge_f1') {
    const judged = summaryById.get(trace.id);
    if (!judged || judged.status !== 'ok' || judged.f1 === undefined) throw new Error(`summary judge result missing: ${trace.id}`);
    return {
      ...trace,
      score: judged.f1,
      metricStatus: 'scored',
      metrics: {
        fluency: judged.fluency ?? 0,
        recall: judged.recall ?? 0,
        precision: judged.precision ?? 0,
        f1: judged.f1,
      },
    };
  }
  if (trace.metric === 'llm_as_judge') {
    const judged = longMemById.get(longMemJudgeSourceKey(trace.id, trace.question));
    if (!judged || judged.status !== 'ok' || judged.label === undefined) throw new Error(`longmem judge result missing: ${trace.id}`);
    return { ...trace, score: judged.label ? 1 : 0, metricStatus: 'scored', metrics: { accuracy: judged.label ? 1 : 0 } };
  }
  throw new Error(`unsupported pending judge metric: ${trace.metric ?? 'unknown'}`);
}

function rebuildAggregates(report: ExternalRunReport): ExternalRunReport {
  report.cases = report.traces.length;
  report.completed = report.traces.filter(trace => trace.status === 'ok').length;
  report.failed = report.cases - report.completed;
  report.byCategory = {};
  report.byMetric = {};
  for (const trace of report.traces) {
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
      const metric = report.byMetric[trace.metric] ?? { cases: 0, score: 0, pending: 0 };
      metric.cases += 1;
      if (trace.metricStatus === 'scored' && trace.score !== undefined) metric.score += trace.score;
      else metric.pending += 1;
      report.byMetric[trace.metric] = metric;
    }
  }
  for (const category of Object.values(report.byCategory)) category.score = category.scored ? category.score / category.scored : 0;
  for (const metric of Object.values(report.byMetric)) metric.score = metric.cases > metric.pending ? metric.score / (metric.cases - metric.pending) : 0;
  const scored = report.traces.filter(trace => trace.score !== undefined);
  const metricNames = new Set(scored.map(trace => trace.metric ?? 'legacy'));
  report.score = scored.length > 0 && metricNames.size === 1
    ? scored.reduce((sum, trace) => sum + trace.score!, 0) / scored.length
    : undefined;
  report.completedAt = new Date().toISOString();
  return report;
}
