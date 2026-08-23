import { createHash } from 'node:crypto';
import type { MemoryBenchCase, MemoryBenchResult } from '../shared/types.js';

export const CAPTURE_BLIND_REVIEW_SEED = 'cross-feat-mem-09-e-v1';

const CATEGORY_QUOTAS: Record<MemoryBenchCase['category'], number> = {
  preference: 6,
  crud: 6,
  conflict: 6,
  do_not_store: 6,
  semantic: 6,
  isolation: 5,
  security: 5,
  flush: 5,
  degraded: 5,
};

export interface CaptureBlindReviewPack {
  schemaVersion: 'mineclaw-capture-blind-review/v1';
  generatedAt: string;
  seed: string;
  datasetSha256: string;
  mode: 'hybrid';
  sampleCount: 50;
  instructions: string[];
  samples: CaptureBlindReviewSample[];
}

export interface CaptureBlindReviewSample {
  reviewId: string;
  primaryMessages: Array<{ role: 'owner' | 'bot'; content: string; timestamp: number }>;
  foreignProfileMessages: Array<Array<{ role: 'owner' | 'bot'; content: string; timestamp: number }>>;
  observed: {
    capturedMessages: string[];
    activeSourceMessages: string[];
    rejectedReasonCounts: Record<string, number>;
  };
  judgement: { result: 'unreviewed'; notes: '' };
}

export interface CaptureBlindAnswerKey {
  schemaVersion: 'mineclaw-capture-blind-answer-key/v1';
  seed: string;
  datasetSha256: string;
  samples: Array<{
    reviewId: string;
    caseId: string;
    category: MemoryBenchCase['category'];
    expectedCaptureMessageIds: string[];
    expectedOperation: MemoryBenchCase['expectedOperation'];
    expectedRejectionReason: string | null;
  }>;
}

export function captureBlindDatasetSha256(cases: MemoryBenchCase[]): string {
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}

export function selectCaptureBlindCases(
  cases: MemoryBenchCase[],
  seed = CAPTURE_BLIND_REVIEW_SEED,
): MemoryBenchCase[] {
  const selected: MemoryBenchCase[] = [];
  for (const [category, quota] of Object.entries(CATEGORY_QUOTAS) as Array<[MemoryBenchCase['category'], number]>) {
    const candidates = cases
      .filter(item => item.category === category)
      .sort((a, b) => stableRank(seed, a.id).localeCompare(stableRank(seed, b.id)) || a.id.localeCompare(b.id));
    if (candidates.length < quota) throw new Error(`Capture blind review category ${category} has ${candidates.length} cases, expected at least ${quota}`);
    selected.push(...candidates.slice(0, quota));
  }
  return selected.sort((a, b) => stableRank(`${seed}:review-order`, a.id).localeCompare(stableRank(`${seed}:review-order`, b.id)) || a.id.localeCompare(b.id));
}

export function buildCaptureBlindReview(
  allCases: MemoryBenchCase[],
  selectedCases: MemoryBenchCase[],
  results: MemoryBenchResult[],
  options: { seed?: string; generatedAt?: string } = {},
): { reviewPack: CaptureBlindReviewPack; answerKey: CaptureBlindAnswerKey; reviewForm: string } {
  const seed = options.seed ?? CAPTURE_BLIND_REVIEW_SEED;
  if (selectedCases.length !== 50) throw new Error(`Capture blind review requires exactly 50 selected cases, received ${selectedCases.length}`);
  const resultByCase = new Map(results.map(result => [result.caseId, result]));
  if (resultByCase.size !== results.length) throw new Error('Capture blind review results contain duplicate case IDs');
  const datasetSha256 = captureBlindDatasetSha256(allCases);
  const samples: CaptureBlindReviewSample[] = [];
  const keySamples: CaptureBlindAnswerKey['samples'] = [];

  selectedCases.forEach((testCase, index) => {
    const result = resultByCase.get(testCase.id);
    if (!result) throw new Error(`Capture blind review is missing result for ${testCase.id}`);
    const reviewId = `BR-${String(index + 1).padStart(3, '0')}`;
    const messages = testCase.sessions.flatMap(item => item.messages);
    const contentById = new Map(messages.map(item => [item.id, item.content]));
    samples.push({
      reviewId,
      primaryMessages: messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
      foreignProfileMessages: (testCase.foreignProfiles ?? []).map(profile => profile.sessions.flatMap(item => item.messages).map(({ role, content, timestamp }) => ({ role, content, timestamp }))),
      observed: {
        capturedMessages: result.trace.capturedMessageIds.map(id => contentById.get(id) ?? `[来源不在主 Profile：${id}]`),
        activeSourceMessages: result.trace.activeSourceMessageIds.map(id => contentById.get(id) ?? `[来源不在主 Profile：${id}]`),
        rejectedReasonCounts: { ...result.trace.rejected },
      },
      judgement: { result: 'unreviewed', notes: '' },
    });
    keySamples.push({
      reviewId,
      caseId: testCase.id,
      category: testCase.category,
      expectedCaptureMessageIds: [...testCase.expectedCaptureMessageIds],
      expectedOperation: testCase.expectedOperation,
      expectedRejectionReason: testCase.expectedRejectionReason ?? null,
    });
  });

  const reviewPack: CaptureBlindReviewPack = {
    schemaVersion: 'mineclaw-capture-blind-review/v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    seed,
    datasetSha256,
    mode: 'hybrid',
    sampleCount: 50,
    instructions: [
      '先独立判断用户输入是否应形成长期记忆，再检查系统实际 Capture/拒绝结果。',
      '不要在完成全部 50 题前打开 answer-key.json。',
      '每题必须填写通过、失败或不确定，并记录失败理由；实现 Agent 不得代填。',
    ],
    samples,
  };
  const answerKey: CaptureBlindAnswerKey = {
    schemaVersion: 'mineclaw-capture-blind-answer-key/v1',
    seed,
    datasetSha256,
    samples: keySamples,
  };
  return { reviewPack, answerKey, reviewForm: renderReviewForm(reviewPack) };
}

function stableRank(seed: string, caseId: string): string {
  return createHash('sha256').update(`${seed}\0${caseId}`).digest('hex');
}

function renderReviewForm(pack: CaptureBlindReviewPack): string {
  const lines = [
    '# FEAT-MEM-09-E · Capture 50 题非实现者盲审表',
    '',
    `- Seed：\`${pack.seed}\``,
    `- Dataset SHA-256：\`${pack.datasetSha256}\``,
    `- Mode：\`${pack.mode}\``,
    '- 审阅人：',
    '- 审阅时间：',
    '- 与实现工作的关系（必须为非实现者）：',
    '',
    '> 完成全部 50 题前不要打开 `answer-key.json`。每题只能选择一个结论，并写明失败或不确定原因。',
    '',
  ];
  for (const sample of pack.samples) {
    lines.push(`## ${sample.reviewId}`, '', '用户输入：', '');
    for (const message of sample.primaryMessages) lines.push(`- ${message.role}：${message.content}`);
    if (sample.foreignProfileMessages.length > 0) {
      lines.push('', '隔离 Profile 输入：', '');
      sample.foreignProfileMessages.forEach((profile, index) => {
        lines.push(`- Profile ${index + 1}`);
        for (const message of profile) lines.push(`  - ${message.role}：${message.content}`);
      });
    }
    lines.push(
      '',
      '系统实际结果：',
      '',
      `- Captured：${sample.observed.capturedMessages.length > 0 ? sample.observed.capturedMessages.join('；') : '无'}`,
      `- Active sources：${sample.observed.activeSourceMessages.length > 0 ? sample.observed.activeSourceMessages.join('；') : '无'}`,
      `- Rejected reasons：${Object.keys(sample.observed.rejectedReasonCounts).length > 0 ? JSON.stringify(sample.observed.rejectedReasonCounts) : '无'}`,
      '',
      '人工结论（单选）：',
      '',
      '- [ ] 通过',
      '- [ ] 失败',
      '- [ ] 不确定',
      '- 备注：',
      '',
    );
  }
  lines.push('## 汇总签字', '', '- 通过：', '- 失败：', '- 不确定：', '- 审阅人签字：', '- 日期：', '');
  return `${lines.join('\n')}\n`;
}
