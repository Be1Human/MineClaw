import { spawn } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
export const appDir = resolve(scriptDir, '..');

const bindingRelativePath = join(
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
const defaultBindingPath = join(appDir, bindingRelativePath);
const nativeCacheRoot = join(
  appDir,
  'node_modules',
  '.cache',
  'mineclaw-native',
);
const lockPath = join(nativeCacheRoot, 'prepare.lock');
const lockStaleMs = 5 * 60_000;
const lockWaitMs = 2 * 60_000;

async function readPackageVersion(packageName) {
  let current = dirname(require.resolve(packageName));
  while (true) {
    const manifestPath = join(current, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (pkg.name === packageName) return String(pkg.version);
    } catch {
      // 继续向上寻找该包自己的 manifest。
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`找不到 ${packageName} 的 package.json`);
    }
    current = parent;
  }
}

async function runtimeInfo() {
  const electronVersion = await readPackageVersion('electron');
  const sqliteVersion = await readPackageVersion('better-sqlite3');
  const key = [
    `electron-${electronVersion}`,
    `better-sqlite3-${sqliteVersion}`,
    process.platform,
    process.arch,
  ].join('-');
  const cacheDir = join(nativeCacheRoot, key);
  return {
    electronVersion,
    sqliteVersion,
    key,
    cacheDir,
    cacheBindingPath: join(cacheDir, 'better_sqlite3.node'),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        rejectRun(new Error(
          `${command} ${args.join(' ')} 失败（code=${code}, signal=${signal ?? 'none'}）`
          + (detail ? `\n${detail}` : ''),
        ));
      }
    });
  });
}

const probeSource = `
const Database = require('better-sqlite3');
const binding = process.env.MINECLAW_PROBE_BINDING;
const db = new Database(':memory:', binding ? { nativeBinding: binding } : {});
db.exec('CREATE TABLE smoke (value INTEGER NOT NULL)');
db.prepare('INSERT INTO smoke (value) VALUES (?)').run(1);
const row = db.prepare('SELECT value FROM smoke').get();
if (!row || row.value !== 1) throw new Error('sqlite smoke query failed');
db.close();
console.log(JSON.stringify({
  runtime: process.versions.electron ? 'electron' : 'node',
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  modules: process.versions.modules,
  binding: binding ?? 'default'
}));
`;

export async function probeNode(bindingPath) {
  return run(process.execPath, ['-e', probeSource], {
    capture: true,
    env: bindingPath ? { MINECLAW_PROBE_BINDING: bindingPath } : {},
  });
}

export async function probeElectron(bindingPath) {
  const electronExecutable = require('electron');
  return run(electronExecutable, ['-e', probeSource], {
    capture: true,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      MINECLAW_PROBE_BINDING: bindingPath,
    },
  });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveNpmCliPath(
  env = process.env,
  nodeExecutable = process.execPath,
) {
  const candidates = [
    env.npm_execpath,
    join(dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(nodeExecutable), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(nodeExecutable), '..', '..', '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate);
    if (await pathExists(resolvedCandidate)) return resolvedCandidate;
  }

  throw new Error(
    '[native] 找不到 npm CLI；请从 npm script 启动，或确认 npm 与 node 安装在同一目录',
  );
}

async function ensureNodeDefaultBinding() {
  try {
    await probeNode();
    return;
  } catch {
    console.warn('[native] 当前共享 binding 不是 Node ABI，正在恢复普通 Node 基线…');
  }
  const npmCliPath = await resolveNpmCliPath();
  await run(process.execPath, [npmCliPath, 'rebuild', 'better-sqlite3']);
  await probeNode();
}

async function acquireLock() {
  await mkdir(nativeCacheRoot, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const lockStats = await stat(lockPath).catch(() => null);
      if (lockStats && Date.now() - lockStats.mtimeMs > lockStaleMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > lockWaitMs) {
        throw new Error(`[native] 等待原生模块准备锁超时：${lockPath}`);
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
  }
}

async function rebuildElectronBinding(info) {
  await ensureNodeDefaultBinding();
  const tempRoot = await mkdtemp(join(tmpdir(), 'mineclaw-native-'));
  const stagingRoot = join(tempRoot, 'project');
  const stagingNodeModules = join(stagingRoot, 'node_modules');
  const stagingPackage = join(stagingNodeModules, 'better-sqlite3');
  const stagedCacheBinding = join(
    stagingPackage,
    'build',
    'Release',
    'better_sqlite3.node',
  );

  let rebuildError;
  try {
    await mkdir(stagingNodeModules, { recursive: true });
    await cp(join(appDir, 'node_modules', 'better-sqlite3'), stagingPackage, {
      recursive: true,
    });
    await writeFile(
      join(stagingRoot, 'package.json'),
      JSON.stringify({
        name: 'mineclaw-electron-native-staging',
        private: true,
        dependencies: { 'better-sqlite3': info.sqliteVersion },
      }, null, 2),
      'utf8',
    );
    const rebuildMain = require.resolve('@electron/rebuild');
    const rebuildCli = join(dirname(rebuildMain), 'cli.js');
    console.log(
      `[native] 为 Electron ${info.electronVersion} 准备 better-sqlite3 ${info.sqliteVersion}…`,
    );
    await run(process.execPath, [
      rebuildCli,
      '--force',
      '--which-module',
      'better-sqlite3',
      '--version',
      info.electronVersion,
      '--module-dir',
      stagingRoot,
    ]);
    await probeElectron(stagedCacheBinding);
    await mkdir(info.cacheDir, { recursive: true });
    const targetTemp = join(
      info.cacheDir,
      `.better_sqlite3.${process.pid}.tmp.node`,
    );
    await copyFile(stagedCacheBinding, targetTemp);
    await probeElectron(targetTemp);
    await rm(info.cacheBindingPath, { force: true });
    await rename(targetTemp, info.cacheBindingPath);
    await writeFile(
      join(info.cacheDir, 'metadata.json'),
      JSON.stringify({
        schemaVersion: 1,
        electronVersion: info.electronVersion,
        sqliteVersion: info.sqliteVersion,
        platform: process.platform,
        arch: process.arch,
        createdAt: new Date().toISOString(),
      }, null, 2),
      'utf8',
    );
  } catch (error) {
    rebuildError = error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  await probeNode();
  if (rebuildError) throw rebuildError;
  await probeElectron(info.cacheBindingPath);
}

export async function ensureElectronNativeBinding() {
  const info = await runtimeInfo();
  if (await pathExists(info.cacheBindingPath)) {
    try {
      await probeElectron(info.cacheBindingPath);
      console.log(`[native] Electron binding 缓存命中：${info.key}`);
      return info.cacheBindingPath;
    } catch {
      console.warn(`[native] Electron binding 缓存无效，准备重建：${info.key}`);
    }
  }

  const releaseLock = await acquireLock();
  try {
    if (await pathExists(info.cacheBindingPath)) {
      try {
        await probeElectron(info.cacheBindingPath);
        console.log(`[native] Electron binding 缓存命中：${info.key}`);
        return info.cacheBindingPath;
      } catch {
        await rm(info.cacheBindingPath, { force: true });
      }
    }
    await rebuildElectronBinding(info);
    console.log(`[native] Electron binding 已就绪：${info.cacheBindingPath}`);
    return info.cacheBindingPath;
  } finally {
    await releaseLock();
  }
}

export async function checkNativeBindings() {
  const bindingPath = await ensureElectronNativeBinding();
  const nodeResult = await probeNode();
  const electronResult = await probeElectron(bindingPath);
  console.log(`[native] Node probe: ${nodeResult.stdout.trim()}`);
  console.log(`[native] Electron probe: ${electronResult.stdout.trim()}`);
  return bindingPath;
}

async function main() {
  const mode = process.argv[2] ?? '--prepare';
  if (mode === '--check') {
    await checkNativeBindings();
    return;
  }
  if (mode !== '--prepare') {
    throw new Error(`未知参数：${mode}；可用 --prepare 或 --check`);
  }
  const bindingPath = await ensureElectronNativeBinding();
  console.log(bindingPath);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
