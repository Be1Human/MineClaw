import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeLongMemCase,
  longMemJudgePrompt,
  longMemReferences,
  longMemJudgeSourceKey,
  runLongMemJudge,
  type LongMemJudgeReference,
} from '../../../../benchmark/memory/external/memoryAgentBenchLongMemJudge.js';
import { FatalModelRequestError, type ExternalCaseTrace, type MemoryAgentBenchEntry } from '../../../../benchmark/memory/external/external.js';

const reference: LongMemJudgeReference = {
  id: 'case-1',
  questionId: 'q-1',
  questionType: 'temporal-reasoning',
  question: 'How many days?',
  expected: '18 days',
};

const trace = (id: string): ExternalCaseTrace => ({
  id,
  category: 'Accurate_Retrieval',
  subDataset: 'longmemeval_s*',
  question: 'How many days?',
  status: 'ok',
  answer: '19 days',
  expected: ['18 days'],
  metric: 'llm_as_judge',
  metricStatus: 'judge_pending',
  latencyMs: 1,
});

test('MAB LongMem reference 保留 question id/type，不参与 Answer Runner', () => {
  const entries: MemoryAgentBenchEntry[] = [{
    source: 'Accurate_Retrieval',
    subDataset: 'longmemeval_s*',
    context: 'memory',
    questions: ['How many days?'],
    answers: [['18 days']],
    qaPairIds: ['case-1'],
    keypoints: [],
    questionIds: ['q-1'],
    questionTypes: ['temporal-reasoning'],
  }];
  assert.deepEqual(longMemReferences(entries).get(longMemJudgeSourceKey('case-1', 'How many days?')), reference);
  assert.match(longMemJudgePrompt(reference, '19 days'), /off-by-one/);
});

test('MAB LongMem Judge 按官方 yes/no rubric 判定', async () => {
  const yes = await judgeLongMemCase({ trace: trace('case-1'), reference, client: async () => ({ text: 'Yes' }) });
  assert.equal(yes.status, 'ok');
  assert.equal(yes.label, true);
  const no = await judgeLongMemCase({ trace: trace('case-1'), reference, client: async () => ({ text: 'No' }) });
  assert.equal(no.label, false);

  const abstention = longMemJudgePrompt({ ...reference, questionId: 'q_abs' }, 'I do not know');
  assert.match(abstention, /unanswerable/);
  const preference = longMemJudgePrompt({ ...reference, questionType: 'single-session-preference' }, 'personalized');
  assert.match(preference, /personal/i);
});

test('MAB LongMem Judge 续跑跳过已成功 ID，按 question type 汇总', async () => {
  let calls = 0;
  const report = await runLongMemJudge({
    sourceReport: 'source.json',
    sourceTraces: [trace('case-1'), trace('case-2')],
    references: new Map([
      [longMemJudgeSourceKey('case-1', 'How many days?'), reference],
      [longMemJudgeSourceKey('case-2', 'How many days?'), { ...reference, id: 'case-2', questionId: 'q-2', questionType: 'knowledge-update' }],
    ]),
    client: async () => { calls += 1; return { text: 'yes' }; },
    judgeModel: 'deepseek-v4-flash',
    endpoint: 'https://api.deepseek.com',
    initialTraces: [{ id: 'case-1', sourceQuestion: 'How many days?', questionId: 'q-1', questionType: 'temporal-reasoning', status: 'ok', label: true, judgeResponse: 'yes' }],
  });
  assert.equal(calls, 1);
  assert.equal(report.cases, 2);
  assert.equal(report.completed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.accuracy, 1);
  assert.equal(report.officialModelMatched, false);
  assert.equal(report.byQuestionType['temporal-reasoning']?.accuracy, 1);
  assert.equal(report.byQuestionType['knowledge-update']?.accuracy, 1);
});

test('MAB LongMem Judge 遇到 Fatal 后停止领题并输出 Partial Report', async () => {
  const traces = Array.from({ length: 20 }, (_, index) => trace(`case-${index}`));
  const references = new Map(traces.map((item, index) => [longMemJudgeSourceKey(item.id, item.question), { ...reference, id: item.id, questionId: `q-${index}` }]));
  let calls = 0;
  let fatalCases = 0;
  await assert.rejects(
    runLongMemJudge({
      sourceReport: 'source.json',
      sourceTraces: traces,
      references,
      client: async () => { calls += 1; throw new FatalModelRequestError(402, 'balance'); },
      judgeModel: 'deepseek-v4-flash',
      endpoint: 'https://api.deepseek.com',
      concurrency: 2,
      onFatal: report => { fatalCases = report.failed; },
    }),
    FatalModelRequestError,
  );
  assert.ok(calls > 0 && calls <= 2, `calls=${calls}`);
  assert.ok(fatalCases >= 1 && fatalCases <= 2, `fatalCases=${fatalCases}`);
});

test('MAB LongMem Judge 对重复 qa_pair_id 使用问题复合身份', async () => {
  const sourceTraces: ExternalCaseTrace[] = Array.from({ length: 5 }, (_, index) => ({
    ...trace('duplicate-id'),
    question: `Question ${index}`,
    expected: [`Answer ${index}`],
  }));
  const references = new Map(sourceTraces.map((item, index) => [longMemJudgeSourceKey(item.id, item.question), {
    ...reference,
    id: item.id,
    questionId: `q-${index}`,
    question: item.question,
    expected: `Answer ${index}`,
  }]));
  let calls = 0;
  const report = await runLongMemJudge({
    sourceReport: 'source.json',
    sourceTraces,
    references,
    client: async () => { calls += 1; return { text: 'yes' }; },
    judgeModel: 'deepseek-v4-flash',
    endpoint: 'https://api.deepseek.com',
  });
  assert.equal(calls, 5);
  assert.equal(report.completed, 5);
  assert.equal(report.traces.length, 5);
  assert.equal(new Set(report.traces.map(item => item.sourceQuestion)).size, 5);
});

test('MAB LongMem Judge 拒绝重复 ID 的旧歧义 Checkpoint', async () => {
  const sourceTraces: ExternalCaseTrace[] = [
    { ...trace('duplicate-id'), question: 'Question A' },
    { ...trace('duplicate-id'), question: 'Question B' },
  ];
  let calls = 0;
  await assert.rejects(runLongMemJudge({
    sourceReport: 'source.json',
    sourceTraces,
    references: new Map(),
    client: async () => { calls += 1; return { text: 'yes' }; },
    judgeModel: 'deepseek-v4-flash',
    endpoint: 'https://api.deepseek.com',
    initialTraces: [{ id: 'duplicate-id', questionId: 'q', questionType: 'temporal-reasoning', status: 'ok', label: true }],
  }), /lacks sourceQuestion/);
  assert.equal(calls, 0);
});
