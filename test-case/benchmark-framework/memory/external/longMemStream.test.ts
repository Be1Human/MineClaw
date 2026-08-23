import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadLongMemEvalJudgeReferences,
  runLongMemEval,
  sha256,
  sha256File,
  streamLongMemEval,
  type LongMemEvalEntry,
} from '../../../../benchmark/memory/external/external.js';

function entry(id: string, content = '记忆里有 {括号}、[数组]、引号 " 和反斜线 \\。'): LongMemEvalEntry {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `question-${id}`,
    question_date: '2026/07/26',
    answer: `answer-${id}`,
    answer_session_ids: [`session-${id}`],
    haystack_dates: ['2026/07/25'],
    haystack_session_ids: [`session-${id}`],
    haystack_sessions: [[{ role: 'user', content }, { role: 'assistant', content: '收到。' }]],
  };
}

async function collect(path: string, highWaterMark = 7): Promise<LongMemEvalEntry[]> {
  const output: LongMemEvalEntry[] = [];
  for await (const item of streamLongMemEval(path, { highWaterMark })) output.push(item);
  return output;
}

test('BUG-MEM-17 · 流式解析跨 chunk 保留嵌套结构、转义和 Unicode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-longmem-stream-'));
  const path = join(dir, 'dataset.json');
  const expected = [entry('a'), entry('b', 'close-like } ] and escaped \\" text')];
  writeFileSync(path, JSON.stringify(expected, null, 2));
  try {
    const actual = await collect(path);
    assert.deepEqual(actual, expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-MEM-17 · 非数组、截断、尾随垃圾和多余逗号均 fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-longmem-invalid-'));
  const cases: Array<[string, string, RegExp]> = [
    ['not-array.json', JSON.stringify(entry('a')), /must be an array/],
    ['truncated.json', `[${JSON.stringify(entry('a'))}`, /missing the closing/],
    ['truncated-entry.json', `[{"question_id":"a"`, /truncated inside entry/],
    ['trailing.json', `${JSON.stringify([entry('a')])}x`, /trailing content/],
    ['extra-comma.json', `[${JSON.stringify(entry('a'))},]`, /expected an object/],
  ];
  try {
    for (const [name, body, expected] of cases) {
      const path = join(dir, name);
      writeFileSync(path, body);
      await assert.rejects(() => collect(path), expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-MEM-17 · 流式 SHA-256 与同步小文件哈希一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-longmem-hash-'));
  const path = join(dir, 'dataset.json');
  writeFileSync(path, JSON.stringify([entry('a')]));
  try {
    assert.equal(await sha256File(path), sha256(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-MEM-17 · Judge 参考加载只保留评分字段和所需 ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-longmem-judge-ref-'));
  const path = join(dir, 'dataset.json');
  writeFileSync(path, JSON.stringify([entry('a'), entry('b')]));
  try {
    const references = await loadLongMemEvalJudgeReferences(path, new Set(['b']));
    assert.deepEqual([...references.keys()], ['b']);
    assert.deepEqual(references.get('b'), {
      question_id: 'b',
      question_type: 'single-session-user',
      question: 'question-b',
      answer: 'answer-b',
    });
    assert.equal('haystack_sessions' in references.get('b')!, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-MEM-17 · limit 在首条后关闭输入流，不预解析后续损坏 Entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-longmem-limit-'));
  const path = join(dir, 'dataset.json');
  writeFileSync(path, `[${JSON.stringify(entry('a'))},{"broken"`);
  const previousConcurrency = process.env.MEMORY_BENCH_CONCURRENCY;
  process.env.MEMORY_BENCH_CONCURRENCY = '1';
  try {
    const result = await runLongMemEval({
      dataset: 'longmemeval_m',
      path,
      mode: 'recent_only',
      answerModel: 'test',
      endpoint: 'test',
      client: async () => ({ text: 'answer-a' }),
      limit: 1,
    });
    assert.equal(result.report.completed, 1);
    assert.equal(result.report.failed, 0);
  } finally {
    if (previousConcurrency === undefined) delete process.env.MEMORY_BENCH_CONCURRENCY;
    else process.env.MEMORY_BENCH_CONCURRENCY = previousConcurrency;
    rmSync(dir, { recursive: true, force: true });
  }
});
