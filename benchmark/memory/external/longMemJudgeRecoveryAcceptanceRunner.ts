import assert from 'node:assert/strict';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import {
  FatalModelRequestError,
  createOpenAICompatibleClient,
  loadMemoryAgentBench,
  type ExternalCaseTrace,
} from './external.js';
import {
  longMemJudgeSourceKey,
  longMemReferences,
  runLongMemJudge,
  type LongMemJudgeReport,
} from './memoryAgentBenchLongMemJudge.js';
import { EXTERNAL_REPORT_DIR, MEMORY_AGENT_BENCH_DATA_DIR } from './paths.js';

const reportsDir = EXTERNAL_REPORT_DIR;
const runId = Date.now();
const sourceReportPath = join(reportsDir, `memoryagentbench-longmem-recovery-source-${runId}.json`);
const checkpointPath = join(reportsDir, `memoryagentbench-longmem-recovery-inprogress-${runId}.json`);
const reportPath = join(reportsDir, `memoryagentbench-longmem-recovery-${runId}.json`);
const references = longMemReferences(loadMemoryAgentBench(
  MEMORY_AGENT_BENCH_DATA_DIR,
  'Accurate_Retrieval',
));
const sourceTraces: ExternalCaseTrace[] = [...references.values()].map(reference => ({
  id: reference.id,
  category: 'Accurate_Retrieval',
  subDataset: 'longmemeval_recovery_acceptance',
  question: reference.question,
  status: 'ok',
  answer: 'fault-injection answer',
  expected: [reference.expected],
  metric: 'llm_as_judge',
  metricStatus: 'judge_pending',
  latencyMs: 0,
}));
assert.equal(sourceTraces.length, 300, '官方 LongMem Judge Case 数必须为 300');
assert.equal(
  new Set(sourceTraces.map(trace => longMemJudgeSourceKey(trace.id, trace.question))).size,
  300,
  'Judge 复合身份必须保持 300 个唯一 Case',
);

mkdirSync(reportsDir, { recursive: true });
writeJsonAtomic(sourceReportPath, {
  schemaVersion: 'mineclaw-memoryagentbench-longmem-recovery-source/v1',
  protocolOnly: true,
  cases: sourceTraces.length,
  traces: sourceTraces,
});

let phase: 'fatal' | 'recovered' = 'fatal';
let phaseCalls = 0;
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  phaseCalls += 1;
  response.setHeader('Content-Type', 'application/json');
  if (phase === 'fatal' && phaseCalls === 2) {
    response.writeHead(402).end(JSON.stringify({ error: { message: 'fault-injection balance exhausted' } }));
    return;
  }
  response.writeHead(200).end(JSON.stringify({
    choices: [{ message: { content: 'yes' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
});

await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const port = (server.address() as AddressInfo).port;
const envNames = ['MEMORY_BENCH_API_KEY', 'MEMORY_BENCH_BASE_URL', 'MEMORY_BENCH_MODEL', 'MEMORY_BENCH_RETRIES'] as const;
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let partial: LongMemJudgeReport | undefined;

try {
  process.env.MEMORY_BENCH_API_KEY = 'fault-injection-key';
  process.env.MEMORY_BENCH_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.MEMORY_BENCH_MODEL = 'fault-injection-judge';
  process.env.MEMORY_BENCH_RETRIES = '0';
  const failingClient = createOpenAICompatibleClient();

  await assert.rejects(
    () => runLongMemJudge({
      sourceReport: sourceReportPath,
      sourceTraces,
      references,
      client: failingClient.client,
      judgeModel: failingClient.model,
      endpoint: failingClient.endpoint,
      concurrency: 1,
      onFatal: report => {
        partial = report;
        writeJsonAtomic(checkpointPath, report);
      },
    }),
    FatalModelRequestError,
  );
  assert.equal(phaseCalls, 2);
  assert.equal(partial?.cases, 300);
  assert.equal(partial?.completed, 1);
  assert.equal(partial?.failed, 1);

  phase = 'recovered';
  phaseCalls = 0;
  const recoveredClient = createOpenAICompatibleClient();
  const recovered = await runLongMemJudge({
    sourceReport: sourceReportPath,
    sourceTraces,
    references,
    client: recoveredClient.client,
    judgeModel: recoveredClient.model,
    endpoint: recoveredClient.endpoint,
    concurrency: 8,
    initialTraces: partial.traces,
  });
  assert.equal(recovered.cases, 300);
  assert.equal(recovered.completed, 300);
  assert.equal(recovered.failed, 0);
  assert.equal(phaseCalls, 299, '恢复阶段必须跳过首轮成功 Case');
  assert.equal(
    new Set(recovered.traces.map(trace => longMemJudgeSourceKey(trace.id, trace.sourceQuestion ?? ''))).size,
    300,
  );
  writeJsonAtomic(reportPath, { ...recovered, protocolOnly: true });

  console.log(JSON.stringify({
    schemaVersion: 'mineclaw-memoryagentbench-longmem-recovery-acceptance/v1',
    protocolOnly: true,
    partial: {
      cases: partial.cases,
      completed: partial.completed,
      failed: partial.failed,
      checkpointPath,
    },
    recovered: {
      cases: recovered.cases,
      completed: recovered.completed,
      failed: recovered.failed,
      recoveryCalls: phaseCalls,
      uniqueCompositeIdentities: 300,
      reportPath,
    },
  }, null, 2));
} finally {
  for (const name of envNames) {
    const previous = previousEnv[name];
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  renameSync(temporaryPath, path);
}
