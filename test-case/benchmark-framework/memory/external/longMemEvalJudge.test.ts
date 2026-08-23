import assert from 'node:assert/strict';
import test from 'node:test';
import { FatalModelRequestError, type LongMemEvalJudgeReference } from '../../../../benchmark/memory/external/external.js';
import {
  assertLongMemEvalJudgeResumeCompatible,
  runLongMemEvalJudge,
  type LongMemEvalHypothesis,
  type LongMemEvalJudgeReport,
} from '../../../../benchmark/memory/external/longMemEvalJudge.js';

const hypotheses: LongMemEvalHypothesis[] = Array.from({ length: 20 }, (_, index) => ({
  question_id: `q-${index}`,
  hypothesis: 'coffee',
}));

const references = new Map<string, LongMemEvalJudgeReference>(hypotheses.map(item => [item.question_id, {
  question_id: item.question_id,
  question_type: 'single-session-user',
  question: 'What do I like?',
  answer: 'coffee',
}]));

const base = {
  dataset: 'longmemeval_s' as const,
  judgeModel: 'deepseek-v4-flash',
  endpoint: 'https://api.deepseek.com',
  referenceFile: 'reference.json',
  referenceSha256: 'reference-sha',
  hypothesesFile: 'hypotheses.jsonl',
  hypothesesSha256: 'hypotheses-sha',
  hypotheses,
  references,
};

test('LongMemEval Judge 遇到 Fatal 后停止领题并输出 Partial Report', async () => {
  let calls = 0;
  let fatalReport: LongMemEvalJudgeReport | undefined;
  await assert.rejects(
    runLongMemEvalJudge({
      ...base,
      client: async () => { calls += 1; throw new FatalModelRequestError(402, 'balance'); },
      concurrency: 2,
      onFatal: report => { fatalReport = report; },
    }),
    FatalModelRequestError,
  );
  assert.ok(calls > 0 && calls <= 2, `calls=${calls}`);
  assert.ok(fatalReport && fatalReport.failed >= 1 && fatalReport.failed <= 2);
});

test('LongMemEval Judge Resume 跳过成功 Trace 并重试失败 Trace', async () => {
  let calls = 0;
  const report = await runLongMemEvalJudge({
    ...base,
    hypotheses: hypotheses.slice(0, 2),
    references,
    client: async () => { calls += 1; return { text: 'yes' }; },
    initialTraces: [
      { questionId: 'q-0', category: 'single-session-user', status: 'ok', label: true, judgeResponse: 'yes' },
      { questionId: 'q-1', category: 'single-session-user', status: 'error', error: 'HTTP 402' },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(report.completed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.accuracy, 1);
});

test('LongMemEval Judge Resume 对配置不兼容 fail closed', () => {
  assert.doesNotThrow(() => assertLongMemEvalJudgeResumeCompatible(baseReport(), {
    dataset: base.dataset,
    judgeModel: base.judgeModel,
    endpoint: `${base.endpoint}/v1`,
    referenceSha256: base.referenceSha256,
    hypothesesSha256: base.hypothesesSha256,
  }));
  assert.throws(() => assertLongMemEvalJudgeResumeCompatible(baseReport(), {
    dataset: base.dataset,
    judgeModel: base.judgeModel,
    endpoint: base.endpoint,
    referenceSha256: base.referenceSha256,
    hypothesesSha256: 'changed',
  }), /hypothesesSha256/);
});

function baseReport(): LongMemEvalJudgeReport {
  return {
    schemaVersion: 'mineclaw-longmemeval-judge/v1',
    dataset: base.dataset,
    evaluator: 'LongMemEval official rubric adapted to OpenAI-compatible API',
    judgeModel: base.judgeModel,
    endpoint: base.endpoint,
    referenceFile: base.referenceFile,
    referenceSha256: base.referenceSha256,
    hypothesesFile: base.hypothesesFile,
    hypothesesSha256: base.hypothesesSha256,
    startedAt: '',
    completedAt: '',
    cases: 0,
    completed: 0,
    failed: 0,
    accuracy: 0,
    abstentionAccuracy: 0,
    byCategory: {},
    traces: [],
  };
}
