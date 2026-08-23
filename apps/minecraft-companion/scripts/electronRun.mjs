import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  appDir,
  ensureElectronNativeBinding,
} from './electronNative.mjs';

async function main() {
  const mode = process.argv[2] ?? 'dev';
  if (!['dev', 'preview'].includes(mode)) {
    throw new Error(`不支持的 electron-vite 模式：${mode}`);
  }

  const bindingPath = await ensureElectronNativeBinding();
  const electronViteCli = join(
    appDir,
    'node_modules',
    'electron-vite',
    'bin',
    'electron-vite.js',
  );
  const child = spawn(
    process.execPath,
    [electronViteCli, mode, ...process.argv.slice(3)],
    {
      cwd: appDir,
      env: {
        ...process.env,
        MINECLAW_SQLITE_NATIVE_BINDING: bindingPath,
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  );

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', error => {
    console.error('[electron] 启动失败：', error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[electron] 子进程被信号终止：${signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
