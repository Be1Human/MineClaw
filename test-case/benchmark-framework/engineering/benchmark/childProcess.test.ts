import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runChildProcess } from '../../../../benchmark/engineering/childProcess.js';

const cwd = process.cwd();

test('BUG-CROSS-26 · 持续输出会刷新 idle watchdog', async () => {
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const script = `let n=0;const t=setInterval(()=>{console.log('beat-'+(++n));if(n===6){clearInterval(t);process.exit(0)}},300)`;

  const result = await runChildProcess(process.execPath, ['-e', script], {
    cwd,
    // Windows 繁忙时冷启动 Node 可超过 200ms；门限覆盖启动，但小于整段输出总时长。
    idleTimeoutMs: 1000,
    hardTimeoutMs: 5000,
    watchdogIntervalMs: 25,
    stdout: output,
    stderr: output,
  });

  assert.equal(result.exitCode, 0, JSON.stringify({ result, text }));
  assert.equal(result.timedOut, false);
  assert.match(text, /beat-6/);
});

test('BUG-CROSS-26 · 静默子进程触发 idle timeout 并退出', async () => {
  const output = new PassThrough();
  const result = await runChildProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
    cwd,
    idleTimeoutMs: 100,
    hardTimeoutMs: 2000,
    watchdogIntervalMs: 10,
    killGraceMs: 50,
    stdout: output,
    stderr: output,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutKind, 'idle');
  assert.ok(result.elapsedMs < 1500, `应在 idle timeout 后快速收敛，实际 ${result.elapsedMs}ms`);
});

test('BUG-CROSS-26 · 持续输出也不能绕过 hard timeout', async () => {
  const output = new PassThrough();
  const script = `setInterval(()=>console.log('busy'),100)`;
  const result = await runChildProcess(process.execPath, ['-e', script], {
    cwd,
    idleTimeoutMs: 1000,
    hardTimeoutMs: 1500,
    watchdogIntervalMs: 25,
    killGraceMs: 50,
    stdout: output,
    stderr: output,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutKind, 'hard');
  assert.ok(result.elapsedMs < 2500, `应在 hard timeout 后快速收敛，实际 ${result.elapsedMs}ms`);
});
