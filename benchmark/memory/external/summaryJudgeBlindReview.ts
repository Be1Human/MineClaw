import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ExternalCaseTrace, ExternalRunReport } from './external.js';
import type { SummaryJudgeReport, SummaryJudgeTrace, SummaryReference } from './memoryAgentBenchSummaryJudge.js';

export const SUMMARY_JUDGE_BLIND_REVIEW_SEED = 'cross-feat-mem-09-f-summary-judge-v1';

export interface SummaryJudgeBlindReviewPack {
  schemaVersion: 'mineclaw-summary-judge-blind-review/v1';
  generatedAt: string;
  seed: string;
  sourceReportSha256: string;
  judgeReportSha256: string;
  sampleCount: 50;
  instructions: string[];
  samples: Array<{
    reviewId: string;
    providedSummary: string;
    keypoints: string[];
    expertSummary: string;
    humanJudgement: {
      fluency: null;
      supportedKeyPointIndices: number[];
      unsupportedSentenceIndices: number[];
      notes: '';
    };
  }>;
}

export interface SummaryJudgeBlindAnswerKey {
  schemaVersion: 'mineclaw-summary-judge-blind-answer-key/v1';
  seed: string;
  sourceReportSha256: string;
  judgeReportSha256: string;
  samples: Array<{
    reviewId: string;
    caseId: string;
    machineJudge: Pick<SummaryJudgeTrace,
      'fluency' | 'recallFound' | 'recallTotal' | 'precisionFound' | 'precisionTotal' | 'recall' | 'precision' | 'f1' |
      'fluencyOutput' | 'recallOutput' | 'precisionOutput'>;
  }>;
}

export function buildSummaryJudgeBlindReview(options: {
  sourceReportPath: string;
  sourceReport: ExternalRunReport;
  judgeReport: SummaryJudgeReport;
  references: Map<string, SummaryReference>;
  seed?: string;
  generatedAt?: string;
}): { reviewPack: SummaryJudgeBlindReviewPack; answerKey: SummaryJudgeBlindAnswerKey; reviewForm: string } {
  const seed = options.seed ?? SUMMARY_JUDGE_BLIND_REVIEW_SEED;
  validateReports(options.sourceReportPath, options.sourceReport, options.judgeReport);
  const answerById = uniqueMap(
    options.sourceReport.traces.filter(trace => trace.metric === 'llm_judge_f1'),
    trace => trace.id,
    'Answer summary traces',
  );
  const judgeById = uniqueMap(options.judgeReport.traces, trace => trace.id, 'Summary Judge traces');
  const candidates = [...judgeById.values()].filter(trace => trace.status === 'ok').map(trace => {
    const answer = answerById.get(trace.id);
    const reference = options.references.get(trace.id);
    if (!answer || answer.status !== 'ok' || !answer.answer) throw new Error(`Summary Judge blind review is missing successful Answer trace for ${trace.id}`);
    if (!reference || reference.keypoints.length === 0 || !reference.expertSummary) throw new Error(`Summary Judge blind review is missing Reference for ${trace.id}`);
    assertCompleteJudgeTrace(trace);
    return { id: trace.id, answer, reference, judge: trace };
  });
  if (candidates.length !== options.judgeReport.cases) {
    throw new Error(`Summary Judge blind review expected ${options.judgeReport.cases} complete candidates, received ${candidates.length}`);
  }
  if (candidates.length < 50) throw new Error(`Summary Judge blind review requires at least 50 complete cases, received ${candidates.length}`);
  const selected = candidates
    .sort((a, b) => stableRank(seed, a.id).localeCompare(stableRank(seed, b.id)) || a.id.localeCompare(b.id))
    .slice(0, 50);
  const sourceReportSha256 = digest(options.sourceReport);
  const judgeReportSha256 = digest(options.judgeReport);
  const samples: SummaryJudgeBlindReviewPack['samples'] = [];
  const keySamples: SummaryJudgeBlindAnswerKey['samples'] = [];
  selected.forEach((item, index) => {
    const reviewId = `SJBR-${String(index + 1).padStart(3, '0')}`;
    samples.push({
      reviewId,
      providedSummary: item.answer.answer!,
      keypoints: [...item.reference.keypoints],
      expertSummary: item.reference.expertSummary,
      humanJudgement: { fluency: null, supportedKeyPointIndices: [], unsupportedSentenceIndices: [], notes: '' },
    });
    keySamples.push({
      reviewId,
      caseId: item.id,
      machineJudge: {
        fluency: item.judge.fluency,
        recallFound: item.judge.recallFound,
        recallTotal: item.judge.recallTotal,
        precisionFound: item.judge.precisionFound,
        precisionTotal: item.judge.precisionTotal,
        recall: item.judge.recall,
        precision: item.judge.precision,
        f1: item.judge.f1,
        fluencyOutput: item.judge.fluencyOutput,
        recallOutput: item.judge.recallOutput,
        precisionOutput: item.judge.precisionOutput,
      },
    });
  });
  const reviewPack: SummaryJudgeBlindReviewPack = {
    schemaVersion: 'mineclaw-summary-judge-blind-review/v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    seed,
    sourceReportSha256,
    judgeReportSha256,
    sampleCount: 50,
    instructions: [
      '先独立评价模型摘要，再在完成全部 50 题后打开答案键。',
      'Fluency 只能填 0 或 1；支持的 Keypoint 和不支持句子均填写从 1 开始的编号。',
      '实现 Agent 不得代填人工判断；分歧必须保留原始备注。',
    ],
    samples,
  };
  const answerKey: SummaryJudgeBlindAnswerKey = {
    schemaVersion: 'mineclaw-summary-judge-blind-answer-key/v1',
    seed,
    sourceReportSha256,
    judgeReportSha256,
    samples: keySamples,
  };
  return { reviewPack, answerKey, reviewForm: renderReviewForm(reviewPack) };
}

function validateReports(sourceReportPath: string, source: ExternalRunReport, judge: SummaryJudgeReport): void {
  if (source.dataset !== 'memoryagentbench') throw new Error('Summary Judge blind review requires a MemoryAgentBench Answer report');
  if (source.completed !== source.cases || source.failed !== 0) {
    throw new Error(`Summary Judge blind review requires a complete Answer report: cases=${source.cases} completed=${source.completed} failed=${source.failed}`);
  }
  if (resolve(judge.sourceReport) !== resolve(sourceReportPath)) throw new Error('Summary Judge blind review sourceReport mismatch');
  if (judge.completed !== judge.cases || judge.failed !== 0) {
    throw new Error(`Summary Judge blind review requires a complete Judge report: cases=${judge.cases} completed=${judge.completed} failed=${judge.failed}`);
  }
  if (judge.traces.length !== judge.cases) throw new Error(`Summary Judge blind review trace count mismatch: cases=${judge.cases} traces=${judge.traces.length}`);
}

function assertCompleteJudgeTrace(trace: SummaryJudgeTrace): asserts trace is SummaryJudgeTrace & Required<Omit<SummaryJudgeTrace, 'error'>> {
  const fields: Array<keyof SummaryJudgeTrace> = [
    'fluency', 'recallFound', 'recallTotal', 'precisionFound', 'precisionTotal', 'recall', 'precision', 'f1',
    'fluencyOutput', 'recallOutput', 'precisionOutput',
  ];
  for (const field of fields) if (trace[field] === undefined) throw new Error(`Summary Judge trace ${trace.id} is missing ${field}`);
}

function uniqueMap<T>(items: T[], id: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = id(item);
    if (result.has(key)) throw new Error(`${label} contain duplicate ID ${key}`);
    result.set(key, item);
  }
  return result;
}

function stableRank(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}\0${id}`).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function renderReviewForm(pack: SummaryJudgeBlindReviewPack): string {
  const lines = [
    '# FEAT-MEM-09-F · Summary Judge 50 题一致性盲审表',
    '',
    `- Seed：\`${pack.seed}\``,
    `- Answer SHA-256：\`${pack.sourceReportSha256}\``,
    `- Judge SHA-256：\`${pack.judgeReportSha256}\``,
    '- 审阅人：',
    '- 审阅时间：',
    '- 与实现工作的关系（必须为非实现者）：',
    '',
    '> 完成全部 50 题前不要打开 `answer-key.json`。',
    '',
  ];
  for (const sample of pack.samples) {
    lines.push(
      `## ${sample.reviewId}`,
      '',
      '### 模型摘要',
      '',
      sample.providedSummary,
      '',
      '### Reference Keypoints',
      '',
      ...sample.keypoints.map((point, index) => `${index + 1}. ${point}`),
      '',
      '### Expert Summary',
      '',
      sample.expertSummary,
      '',
      '### 人工判断',
      '',
      '- Fluency（0/1）：',
      '- 支持的 Keypoint 编号：',
      '- 不支持的模型摘要句子编号：',
      '- 备注：',
      '',
    );
  }
  lines.push('## 汇总签字', '', '- 审阅人签字：', '- 日期：', '- 与机器 Judge 的分歧数：', '- 分歧说明：', '');
  return `${lines.join('\n')}\n`;
}
