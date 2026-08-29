import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  appDir,
  ensureElectronNativeBinding,
} from './electronNative.mjs';
import { resolveElectronDevStrategy } from './electronDevStrategy.mjs';

const require = createRequire(import.meta.url);

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const forward = signal => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const cleanup = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    child.on('error', error => {
      cleanup();
      rejectRun(error);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolveRun();
      else rejectRun(new Error(signal ? `子进程被信号终止：${signal}` : `子进程退出：code=${code ?? 'unknown'}`));
    });
  });
}

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
  const baseEnv = {
    ...process.env,
    MINECLAW_SQLITE_NATIVE_BINDING: bindingPath,
  };
  if (mode === 'dev') {
    const strategy = await resolveElectronDevStrategy();
    if (strategy.mode === 'attach') {
      console.log(`[electron] 复用现有开发服务：Hub ${strategy.hubUrl} / Web ${strategy.rendererUrl}`);
      await run(process.execPath, [electronViteCli, 'build'], baseEnv);
      const electronExecutable = require('electron');
      await run(electronExecutable, [join(appDir, 'out', 'main', 'index.cjs')], {
        ...baseEnv,
        MINECLAW_HUB_URL: strategy.hubUrl,
        ELECTRON_RENDERER_URL: strategy.rendererUrl,
      });
      return;
    }
  }
  await run(process.execPath, [electronViteCli, mode, ...process.argv.slice(3)], baseEnv);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
