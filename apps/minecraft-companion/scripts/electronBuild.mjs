import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  appDir,
  probeNode,
} from './electronNative.mjs';

const require = createRequire(import.meta.url);
const defaultBindingPath = join(
  appDir,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', rejectRun);
    child.on('exit', code => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} 失败（code=${code}）`));
    });
  });
}

async function main() {
  await probeNode();
  const tempRoot = await mkdtemp(join(tmpdir(), 'mineclaw-electron-build-'));
  const backupBinding = join(tempRoot, 'better_sqlite3.node');
  await copyFile(defaultBindingPath, backupBinding);

  try {
    const electronViteCli = join(
      appDir,
      'node_modules',
      'electron-vite',
      'bin',
      'electron-vite.js',
    );
    await run(process.execPath, [electronViteCli, 'build']);

    const builderMain = require.resolve('electron-builder');
    const builderCli = join(dirname(builderMain), 'cli', 'cli.js');
    await run(process.execPath, [builderCli]);
  } finally {
    await copyFile(backupBinding, defaultBindingPath);
    await rm(tempRoot, { recursive: true, force: true });
  }
  await probeNode();
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
