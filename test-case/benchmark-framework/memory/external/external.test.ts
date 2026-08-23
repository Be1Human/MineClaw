import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FatalModelRequestError, chunkMemoryAgentBenchText, createCheckpointWriter, createOpenAICompatibleClient, loadLongMemEval, memoryAgentBenchContextTrace, memoryAgentBenchFiles, memoryAgentBenchPromptVersion, readExternalCheckpoint, resumeMemoryAgentBenchReport, runLongMemEval, runMemoryAgentBench, scoreMemoryAgentBench, type ExternalRunReport } from '../../../../benchmark/memory/external/external.js';
import { LONGMEMEVAL_JUDGE_SYSTEM_PROMPT, longMemEvalJudgePrompt } from '../../../../benchmark/memory/external/longMemJudgeRubric.js';

function externalReport(overrides: Partial<ExternalRunReport> = {}): ExternalRunReport {
  return {
    dataset: 'memoryagentbench',
    mode: 'recent_only',
    answerModel: 'test-model',
    endpoint: 'https://example.test',
    promptVersion: 'prompt-v1',
    datasetFile: 'dataset',
    datasetSha256: 'dataset-v1',
    startedAt: '2026-07-26T00:00:00.000Z',
    completedAt: '',
    cases: 0,
    completed: 0,
    failed: 0,
    byCategory: {},
    traces: [],
    ...overrides,
  };
}

test('LongMemEval 适配器按原始 session 回放，输出官方 question_id/hypothesis 结构', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-external-test-'));
  const path = join(dir, 'sample.json');
  writeFileSync(path, JSON.stringify([{
    question_id: 'official-id', question_type: 'single-session-user', question: 'What do I like?', question_date: '2024/01/01', answer: 'coffee',
    answer_session_ids: ['s-1'], haystack_dates: ['2024/01/01'], haystack_session_ids: ['s-1'],
    haystack_sessions: [[{ role: 'user', content: 'I like coffee.' }, { role: 'assistant', content: 'Noted.' }]],
  }]));
  try {
    const entries = loadLongMemEval(path);
    assert.equal(entries[0]?.haystack_sessions[0]?.[0]?.content, 'I like coffee.');
    // 不读取答案字段；只验证传给模型的记忆上下文来自会话回放。
    const calls: Array<{ system: string; prompt: string }> = [];
    const result = await runLongMemEval({ dataset: 'longmemeval_oracle', path, mode: 'hybrid', answerModel: 'test', endpoint: 'test', client: async input => { calls.push(input); return { text: 'coffee' }; }, limit: 1 });
    assert.deepEqual(result.hypotheses, [{ question_id: 'official-id', hypothesis: 'coffee' }]);
    assert.equal(result.report.traces[0]?.question, 'What do I like?');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.system, /only owner messages or confirmed user facts are authoritative/);
    assert.match(calls[0]!.system, /reply exactly "Unknown\."/);
    assert.match(calls[0]!.prompt, /相关历史（owner）：I like coffee\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-MEM-18 · LongMemEval Judge 使用官方任务分支与宽松拒答 rubric', () => {
  assert.equal(LONGMEMEVAL_JUDGE_SYSTEM_PROMPT, 'Return yes or no only.');
  assert.doesNotMatch(LONGMEMEVAL_JUDGE_SYSTEM_PROMPT, /strict/i);

  const abstention = longMemEvalJudgePrompt('single-session-user', 'Where?', 'Not stated.', 'Unknown.', true);
  assert.match(abstention, /information is incomplete/);
  assert.match(abstention, /correctly identifies the question as unanswerable/);

  const temporal = longMemEvalJudgePrompt('temporal-reasoning', 'How many days?', '18', '19', false);
  assert.match(temporal, /off-by-one/);
  const update = longMemEvalJudgePrompt('knowledge-update', 'Which?', 'new', 'old, then new', false);
  assert.match(update, /updated answer is present/);
  const preference = longMemEvalJudgePrompt('single-session-preference', 'Suggest?', 'quiet', 'A quiet cafe', false);
  assert.match(preference, /need not reflect every rubric point/);
});

test('外部模型请求超时会结束，而不会永久挂起评测队列', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.MEMORY_BENCH_API_KEY;
  const previousTimeout = process.env.MEMORY_BENCH_TIMEOUT_MS;
  const previousRetries = process.env.MEMORY_BENCH_RETRIES;
  process.env.MEMORY_BENCH_API_KEY = 'test-key-not-a-secret';
  process.env.MEMORY_BENCH_TIMEOUT_MS = '1000';
  process.env.MEMORY_BENCH_RETRIES = '0';
  globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true });
  })) as typeof fetch;
  try {
    const { client } = createOpenAICompatibleClient();
    await assert.rejects(() => client({ system: 'test', prompt: 'test' }), /timeout after 1000ms/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MEMORY_BENCH_API_KEY; else process.env.MEMORY_BENCH_API_KEY = previousKey;
    if (previousTimeout === undefined) delete process.env.MEMORY_BENCH_TIMEOUT_MS; else process.env.MEMORY_BENCH_TIMEOUT_MS = previousTimeout;
    if (previousRetries === undefined) delete process.env.MEMORY_BENCH_RETRIES; else process.env.MEMORY_BENCH_RETRIES = previousRetries;
  }
});

test('外部模型对可恢复 HTTP 错误执行有界重试', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.MEMORY_BENCH_API_KEY;
  const previousRetries = process.env.MEMORY_BENCH_RETRIES;
  process.env.MEMORY_BENCH_API_KEY = 'test-key-not-a-secret';
  process.env.MEMORY_BENCH_RETRIES = '1';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response('busy', { status: 503 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const { client } = createOpenAICompatibleClient();
    assert.equal((await client({ system: 'test', prompt: 'test' })).text, 'ok');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MEMORY_BENCH_API_KEY; else process.env.MEMORY_BENCH_API_KEY = previousKey;
    if (previousRetries === undefined) delete process.env.MEMORY_BENCH_RETRIES; else process.env.MEMORY_BENCH_RETRIES = previousRetries;
  }
});

test('BUG-MEM-19 · 402 被识别为批次 Fatal，且响应正文保持脱敏', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.MEMORY_BENCH_API_KEY;
  const previousRetries = process.env.MEMORY_BENCH_RETRIES;
  process.env.MEMORY_BENCH_API_KEY = 'test-key-not-a-secret';
  process.env.MEMORY_BENCH_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{"message":"balance exhausted for sk-should-not-leak"}', { status: 402 });
  }) as typeof fetch;
  try {
    const { client } = createOpenAICompatibleClient();
    await assert.rejects(
      () => client({ system: 'test', prompt: 'test' }),
      (error: unknown) => error instanceof FatalModelRequestError
        && error.status === 402
        && error.message.includes('[redacted]')
        && !error.message.includes('sk-should-not-leak'),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MEMORY_BENCH_API_KEY; else process.env.MEMORY_BENCH_API_KEY = previousKey;
    if (previousRetries === undefined) delete process.env.MEMORY_BENCH_RETRIES; else process.env.MEMORY_BENCH_RETRIES = previousRetries;
  }
});

test('BUG-MEM-19 · LongMemEval Fatal 先写 Error Trace 和 Checkpoint 再停止批次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-external-fatal-'));
  const path = join(dir, 'fatal.json');
  const previousConcurrency = process.env.MEMORY_BENCH_CONCURRENCY;
  process.env.MEMORY_BENCH_CONCURRENCY = '1';
  writeFileSync(path, JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
    question_id: `fatal-${index}`, question_type: 'single-session-user', question: 'What do I like?', question_date: '2024/01/01', answer: 'coffee',
    answer_session_ids: ['s-1'], haystack_dates: ['2024/01/01'], haystack_session_ids: ['s-1'],
    haystack_sessions: [[{ role: 'user', content: 'I like coffee.' }]],
  }))));
  let calls = 0;
  let fatalReport: ExternalRunReport | undefined;
  try {
    await assert.rejects(
      () => runLongMemEval({
        dataset: 'longmemeval_oracle', path, mode: 'hybrid', answerModel: 'test', endpoint: 'test',
        client: async () => { calls += 1; throw new FatalModelRequestError(402, 'balance'); },
        onFatal: report => { fatalReport = report; },
      }),
      FatalModelRequestError,
    );
    assert.equal(calls, 1);
    assert.equal(fatalReport?.cases, 1);
    assert.equal(fatalReport?.failed, 1);
    assert.equal(fatalReport?.traces[0]?.status, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previousConcurrency === undefined) delete process.env.MEMORY_BENCH_CONCURRENCY; else process.env.MEMORY_BENCH_CONCURRENCY = previousConcurrency;
  }
});

test('BUG-MEM-19 · MemoryAgentBench 从真实 402 Checkpoint 恢复后保留成功题并完成批次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-external-recovery-'));
  const checkpointPath = join(dir, 'checkpoint.json');
  const previousFetch = globalThis.fetch;
  const names = ['MEMORY_BENCH_API_KEY', 'MEMORY_BENCH_BASE_URL', 'MEMORY_BENCH_MODEL', 'MEMORY_BENCH_RETRIES', 'MEMORY_BENCH_CONCURRENCY'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.MEMORY_BENCH_API_KEY = 'test-key-not-a-secret';
  process.env.MEMORY_BENCH_BASE_URL = 'https://recovery.example.test/v1';
  process.env.MEMORY_BENCH_MODEL = 'recovery-test-model';
  process.env.MEMORY_BENCH_RETRIES = '0';
  process.env.MEMORY_BENCH_CONCURRENCY = '2';
  let firstRunCalls = 0;
  let fatalReport: ExternalRunReport | undefined;
  globalThis.fetch = (async () => {
    firstRunCalls += 1;
    return firstRunCalls === 2
      ? new Response('{"message":"balance exhausted"}', { status: 402 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'first-pass-answer' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
  }) as typeof fetch;
  try {
    const firstClient = createOpenAICompatibleClient();
    await assert.rejects(
      () => runMemoryAgentBench({
        mode: 'recent_only',
        client: firstClient.client,
        answerModel: firstClient.model,
        endpoint: firstClient.endpoint,
        category: 'Conflict_Resolution',
        limit: 3,
        onFatal: report => {
          fatalReport = report;
          writeFileSync(checkpointPath, JSON.stringify(report));
        },
      }),
      FatalModelRequestError,
    );
    assert.equal(firstRunCalls, 2);
    assert.equal(fatalReport?.cases, 2);
    assert.equal(fatalReport?.completed, 1);
    assert.equal(fatalReport?.failed, 1);

    const checkpoint = readExternalCheckpoint(checkpointPath);
    let recoveryCalls = 0;
    globalThis.fetch = (async () => {
      recoveryCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered-answer' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const recoveredClient = createOpenAICompatibleClient();
    const recovered = await runMemoryAgentBench({
      mode: 'recent_only',
      client: recoveredClient.client,
      answerModel: recoveredClient.model,
      endpoint: recoveredClient.endpoint,
      category: 'Conflict_Resolution',
      limit: 3,
      resumeReport: checkpoint,
    });

    assert.equal(recoveryCalls, 2, '首轮成功题不得再次请求模型');
    assert.equal(recovered.cases, 3);
    assert.equal(recovered.completed, 3);
    assert.equal(recovered.failed, 0);
    assert.equal(recovered.traces.filter(trace => trace.answer === 'first-pass-answer').length, 1);
    assert.equal(recovered.traces.filter(trace => trace.answer === 'recovered-answer').length, 2);
    assert.equal(recovered.traces.some(trace => trace.status === 'error'), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-MEM-09-A · 可复用 LLM_API_KEY，但不继承不兼容的应用模型名', () => {
  const names = ['MEMORY_BENCH_API_KEY', 'MEMORY_BENCH_MODEL', 'LLM_API_KEY', 'LLM_MODEL'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.MEMORY_BENCH_API_KEY;
    delete process.env.MEMORY_BENCH_MODEL;
    process.env.LLM_API_KEY = 'test-key-not-a-secret';
    process.env.LLM_MODEL = 'deepseek-chat';

    const config = createOpenAICompatibleClient();

    assert.equal(config.model, 'deepseek-v4-flash');
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('BUG-CROSS-23 · 恢复报告保留重复 ID 的成功样本，失败 case 留给续跑重试', () => {
  const ok = { id: 'ok-1', category: 'Accurate_Retrieval', question: 'q', status: 'ok' as const, answer: 'a', expected: ['a'], score: 1, latencyMs: 10 };
  const failed = { id: 'retry-1', category: 'Accurate_Retrieval', question: 'q2', status: 'error' as const, latencyMs: 20, error: 'timeout' };
  const previous = externalReport({ cases: 3, completed: 2, failed: 1, traces: [ok, { ...ok, score: 0 }, failed] });

  const resumed = resumeMemoryAgentBenchReport(previous, externalReport());

  assert.equal(resumed.cases, 2);
  assert.equal(resumed.completed, 2);
  assert.equal(resumed.failed, 0);
  assert.deepEqual(resumed.traces.map(trace => trace.id), ['ok-1', 'ok-1']);
  assert.equal(resumed.score, undefined);
  assert.deepEqual(resumed.byCategory, { Accurate_Retrieval: { cases: 2, score: 1, scored: 2, pending: 0 } });
});

test('BUG-CROSS-23 · 不兼容 checkpoint 在续跑前硬拒绝', () => {
  assert.throws(
    () => resumeMemoryAgentBenchReport(externalReport({ datasetSha256: 'old' }), externalReport()),
    /incompatible MemoryAgentBench checkpoint: datasetSha256/,
  );
});

test('BUG-CROSS-23 · 检索协议只改变 Hybrid/FTS Prompt 版本，不作废无检索基线', () => {
  const recent = memoryAgentBenchPromptVersion('recent_only');
  const full = memoryAgentBenchPromptVersion('full_context');
  const hybrid = memoryAgentBenchPromptVersion('hybrid');
  const fts = memoryAgentBenchPromptVersion('fts5_only');

  assert.equal(recent, 'cd845adf02802b4a30a665fef36d7485c3475b5a6d7a81a58085b41607400c3e');
  assert.equal(full, recent);
  assert.notEqual(fts, hybrid);
  assert.notEqual(fts, recent);
  assert.notEqual(hybrid, recent);
  assert.throws(
    () => resumeMemoryAgentBenchReport(
      externalReport({ mode: 'hybrid', promptVersion: recent }),
      externalReport({ mode: 'hybrid', promptVersion: hybrid }),
    ),
    /incompatible MemoryAgentBench checkpoint: promptVersion/,
  );
});

test('BUG-CROSS-23 · DeepSeek 等价的 /v1 endpoint 可安全续跑', () => {
  const resumed = resumeMemoryAgentBenchReport(
    externalReport({ endpoint: 'https://api.deepseek.com/v1' }),
    externalReport({ endpoint: 'https://api.deepseek.com/' }),
  );
  assert.equal(resumed.endpoint, 'https://api.deepseek.com/');
});

test('BUG-CROSS-23 · checkpoint 按题数节流并支持最终强制 flush', () => {
  const writes: number[] = [];
  let now = 0;
  const writer = createCheckpointWriter({ write: report => writes.push(report.cases), caseInterval: 25, timeIntervalMs: 30_000, now: () => now });
  for (let cases = 1; cases <= 24; cases += 1) writer.update(externalReport({ cases }));
  assert.deepEqual(writes, []);
  writer.update(externalReport({ cases: 25 }));
  assert.deepEqual(writes, [25]);
  writer.update(externalReport({ cases: 26 }));
  writer.flush(externalReport({ cases: 26 }));
  assert.deepEqual(writes, [25, 26]);
  now = 60_000;
  writer.update(externalReport({ cases: 27 }));
  assert.deepEqual(writes, [25, 26, 27]);
});

test('BUG-CROSS-23 · recent-only 直接保留最后 20 个片段并遵守 6000 字符预算', () => {
  const context = Array.from({ length: 30 }, (_, index) => `fact-${index}-${'x'.repeat(590)}`).join('\n\n');
  const trace = memoryAgentBenchContextTrace(context, 'recent_only');
  assert.equal(trace.retrievedMessageIds.length, 20);
  assert.equal(trace.retrievedMessageIds[0], 'context-10');
  assert.equal(trace.retrievedMessageIds[19], 'context-29');
  assert.equal(trace.contextChars, 6000);
  assert.match(trace.context, /fact-29/);
  assert.doesNotMatch(trace.context, /fact-0-/);
});

test('BUG-MEM-15 · MemoryAgentBench 按子任务使用官方可比指标', () => {
  assert.deepEqual(scoreMemoryAgentBench('The answer is France.', ['France'], 'ruler_qa1_197K'), {
    score: 1, metric: 'substring_exact_match', metricStatus: 'scored',
  });
  assert.equal(scoreMemoryAgentBench('label: 28', ['28'], 'icl_banking77_5900shot_balance').score, 0);
  assert.equal(scoreMemoryAgentBench('28', ['28'], 'icl_banking77_5900shot_balance').score, 1);

  const recommendation = scoreMemoryAgentBench('1. This Is Spinal Tap\n2. Kingpin', ['7008'], 'recsys_redial_full');
  assert.equal(recommendation.metric, 'Recall@5');
  assert.equal(recommendation.score, 1);
  assert.equal(recommendation.metrics?.['Recall@1'], 1);

  assert.deepEqual(scoreMemoryAgentBench('A generated summary', ['reference'], 'infbench_sum_eng_shots2'), {
    metric: 'llm_judge_f1', metricStatus: 'judge_pending',
  });
});

test('BUG-MEM-15 · category 筛选发生在 Parquet 解码前', () => {
  assert.deepEqual(memoryAgentBenchFiles('Test_Time_Learning'), ['Test_Time_Learning.parquet']);
  assert.deepEqual(memoryAgentBenchFiles('missing'), []);
  assert.equal(memoryAgentBenchFiles().length, 4);
});

test('BUG-MEM-15 · 多行 Dialogue 在保留行边界后重新装入分片窗口', () => {
  const context = `Dialogue 1:\n${Array.from({ length: 100 }, (_, index) => `User: line-${index}`).join('\n')}`;
  const trace = memoryAgentBenchContextTrace(context, 'full_context');
  assert.ok(trace.retrievedMessageIds.length < 10, `unexpected chunk count: ${trace.retrievedMessageIds.length}`);
  assert.match(trace.context, /line-0/);
  assert.match(trace.context, /line-99/);
});

test('BUG-MEM-15 · Conflict 编号事实保持逐行原子，Dialogue 默认合并', () => {
  const facts = `Here is a list of facts:\n${Array.from({ length: 20 }, (_, index) => `${index}. subject-${index} is value-${index}.`).join('\n')}`;
  const atomic = chunkMemoryAgentBenchText(facts, 600, true);
  const packed = chunkMemoryAgentBenchText(facts, 600, false);
  assert.equal(atomic.length, 21);
  assert.ok(packed.length < atomic.length);
  assert.equal(atomic[1], '0. subject-0 is value-0.');
});
