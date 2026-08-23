import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBodyEvalEnvironment } from '../../../../benchmark/engineering/runtimeEnv.js';

test('BUG-CROSS-21 · 线上 MC_HOST 不得污染统一 Body Benchmark', () => {
  const resolved = resolveBodyEvalEnvironment({ MC_HOST: '43.161.215.184', MC_PORT: '25566' });
  assert.equal(resolved.host, '127.0.0.1');
  assert.equal(resolved.port, '25565');
  assert.equal(resolved.childEnv.EVAL_HOST, '127.0.0.1');
  assert.equal(resolved.childEnv.EVAL_PORT, '25565');
});

test('BUG-CROSS-21 · 显式 EVAL_HOST/EVAL_PORT 保持可覆盖', () => {
  const resolved = resolveBodyEvalEnvironment({ EVAL_HOST: '10.0.0.8', EVAL_PORT: '25570', MC_HOST: 'remote' });
  assert.equal(resolved.host, '10.0.0.8');
  assert.equal(resolved.port, '25570');
});
