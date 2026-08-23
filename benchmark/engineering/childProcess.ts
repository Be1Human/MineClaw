import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

export type ChildTimeoutKind = 'idle' | 'hard';

export interface ChildRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  watchdogIntervalMs?: number;
  killGraceMs?: number;
  stdout?: Writable;
  stderr?: Writable;
}

export interface ChildRunResult {
  exitCode: number;
  timedOut: boolean;
  timeoutKind?: ChildTimeoutKind;
  elapsedMs: number;
}

/**
 * 运行并透传子进程输出，同时用独立于子进程事件循环的 idle/hard watchdog 收敛失活。
 */
export function runChildProcess(
  command: string,
  args: string[],
  options: ChildRunOptions,
): Promise<ChildRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let timeoutKind: ChildTimeoutKind | undefined;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const markActivity = (): void => { lastActivityAt = Date.now(); };
    child.stdout.on('data', (chunk: Buffer) => { markActivity(); stdout.write(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { markActivity(); stderr.write(chunk); });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearInterval(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        exitCode,
        timedOut: timeoutKind !== undefined,
        timeoutKind,
        elapsedMs: Date.now() - startedAt,
      });
    };

    const terminate = (kind: ChildTimeoutKind): void => {
      if (timeoutKind || settled) return;
      timeoutKind = kind;
      stderr.write(`[benchmark] child ${kind} timeout after ${Date.now() - startedAt}ms\n`);
      try { child.kill('SIGTERM'); } catch { /* exit/error 事件负责收敛 */ }
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL'); } catch { /* exit/error 事件负责收敛 */ }
        }
      }, options.killGraceMs ?? 1000);
      forceKillTimer.unref?.();
    };

    const intervalMs = options.watchdogIntervalMs
      ?? Math.max(100, Math.min(1000, Math.floor((options.idleTimeoutMs ?? 60_000) / 4)));
    const idleTimer = setInterval(() => {
      if (options.idleTimeoutMs && Date.now() - lastActivityAt > options.idleTimeoutMs) terminate('idle');
    }, intervalMs);
    idleTimer.unref?.();
    const hardTimer = options.hardTimeoutMs
      ? setTimeout(() => terminate('hard'), options.hardTimeoutMs)
      : undefined;
    hardTimer?.unref?.();

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearInterval(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('exit', code => finish(code ?? 1));
  });
}
