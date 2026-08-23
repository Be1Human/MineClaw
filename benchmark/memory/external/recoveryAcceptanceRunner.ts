import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FatalModelRequestError,
  createOpenAICompatibleClient,
  readExternalCheckpoint,
  runMemoryAgentBench,
  writeExternalArtifacts,
  writeExternalCheckpoint,
  type ExternalRunReport,
} from './external.js';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const parsedLimit = value('--limit');
const limit = parsedLimit ? Number.parseInt(parsedLimit, 10) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 3)) {
  throw new Error('--limit must be an integer >= 3');
}

let phase: 'fatal' | 'recovered' = 'fatal';
let phaseCalls = 0;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  phaseCalls += 1;
  res.setHeader('Content-Type', 'application/json');
  if (phase === 'fatal' && phaseCalls === 2) {
    res.writeHead(402).end(JSON.stringify({ error: { message: 'fault-injection balance exhausted' } }));
    return;
  }
  res.writeHead(200).end(JSON.stringify({
    choices: [{ message: { content: phase === 'fatal' ? 'first-pass-answer' : 'recovered-answer' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
});

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const envNames = ['MEMORY_BENCH_API_KEY', 'MEMORY_BENCH_BASE_URL', 'MEMORY_BENCH_MODEL', 'MEMORY_BENCH_RETRIES', 'MEMORY_BENCH_CONCURRENCY'] as const;
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let partial: ExternalRunReport | undefined;
let checkpointPath = '';

try {
  process.env.MEMORY_BENCH_API_KEY = 'fault-injection-key';
  process.env.MEMORY_BENCH_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.MEMORY_BENCH_MODEL = 'fault-injection-model';
  process.env.MEMORY_BENCH_RETRIES = '0';
  process.env.MEMORY_BENCH_CONCURRENCY = '2';
  const failingClient = createOpenAICompatibleClient();

  await assert.rejects(
    () => runMemoryAgentBench({
      mode: 'recent_only',
      client: failingClient.client,
      answerModel: failingClient.model,
      endpoint: failingClient.endpoint,
      limit,
      onFatal: report => {
        partial = report;
        checkpointPath = writeExternalCheckpoint(report, Date.now());
      },
    }),
    FatalModelRequestError,
  );
  assert.equal(phaseCalls, 2);
  assert.equal(partial?.cases, 2);
  assert.equal(partial?.completed, 1);
  assert.equal(partial?.failed, 1);
  assert.ok(checkpointPath);

  phase = 'recovered';
  phaseCalls = 0;
  process.env.MEMORY_BENCH_CONCURRENCY = '16';
  const recoveredClient = createOpenAICompatibleClient();
  const recovered = await runMemoryAgentBench({
    mode: 'recent_only',
    client: recoveredClient.client,
    answerModel: recoveredClient.model,
    endpoint: recoveredClient.endpoint,
    limit,
    resumeReport: readExternalCheckpoint(checkpointPath),
  });

  assert.equal(recovered.failed, 0);
  assert.equal(recovered.completed, recovered.cases);
  assert.equal(recovered.traces.filter(trace => trace.answer === 'first-pass-answer').length, 1);
  assert.equal(phaseCalls, recovered.cases - 1, '恢复阶段必须跳过首轮成功题');
  const artifacts = writeExternalArtifacts(recovered);
  console.log(JSON.stringify({
    schemaVersion: 'mineclaw-memory-recovery-acceptance/v1',
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
      reportPath: artifacts.reportPath,
    },
  }, null, 2));
} finally {
  for (const name of envNames) {
    const previous = previousEnv[name];
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
}
