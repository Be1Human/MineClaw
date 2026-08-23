import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function repoRootFrom(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = new Map();
  const forwarded = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--') {
      forwarded.push(...rest.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${token} 缺少值`);
    options.set(token.slice(2), value);
    index += 1;
  }
  return { command, options, forwarded };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
}

function validateRunner(runner, label) {
  if (!runner || typeof runner !== 'object') throw new Error(`${label}.runner 缺失`);
  assertString(runner.command, `${label}.runner.command`);
  if (!Array.isArray(runner.args) || runner.args.some(item => typeof item !== 'string')) {
    throw new Error(`${label}.runner.args 必须是字符串数组`);
  }
  if (typeof runner.cwd !== 'string') throw new Error(`${label}.runner.cwd 必须是字符串`);
}

function validateMigrationMap(repoRoot, manifest, workspace) {
  assertString(manifest.migrationMap, 'migrationMap');
  const mapPath = resolve(repoRoot, manifest.migrationMap);
  const migration = readJson(mapPath);
  if (migration.schemaVersion !== 'mineclaw-testing-migration-map/v1') throw new Error('迁移清单版本错误');
  const ids = new Set();
  const oldPaths = new Set();
  const newPaths = new Set();
  let count = 0;
  for (const asset of migration.assets ?? []) {
    if (asset.layer !== workspace) continue;
    count += 1;
    assertString(asset.id, 'asset.id');
    assertString(asset.oldPath, `${asset.id}.oldPath`);
    assertString(asset.newPath, `${asset.id}.newPath`);
    if (!asset.newPath.startsWith(`${workspace}/`)) throw new Error(`${asset.id} 跨层写入 ${asset.newPath}`);
    if (ids.has(asset.id)) throw new Error(`迁移 ID 重复：${asset.id}`);
    if (oldPaths.has(asset.oldPath)) throw new Error(`旧路径重复：${asset.oldPath}`);
    if (newPaths.has(asset.newPath)) throw new Error(`新路径重复：${asset.newPath}`);
    ids.add(asset.id);
    oldPaths.add(asset.oldPath);
    newPaths.add(asset.newPath);
    if (!existsSync(resolve(repoRoot, asset.oldPath)) && !existsSync(resolve(repoRoot, asset.newPath))) {
      throw new Error(`${asset.id} 的旧路径和新路径均不存在`);
    }
  }
  if (count === 0) throw new Error(`${workspace} 没有迁移资产`);
  return count;
}

export function validateWorkspaceManifest({ repoRoot, manifest, workspace, entriesKey }) {
  const expectedVersion = workspace === 'test-case'
    ? 'mineclaw-test-case-manifest/v1'
    : 'mineclaw-benchmark-manifest/v1';
  if (manifest.schemaVersion !== expectedVersion) throw new Error(`Manifest 版本错误：${manifest.schemaVersion}`);
  if (manifest.workspace !== workspace) throw new Error(`Manifest workspace 应为 ${workspace}`);
  const entries = manifest[entriesKey];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${entriesKey} 不能为空`);
  const ids = new Set();
  for (const entry of entries) {
    assertString(entry.id, `${entriesKey}.id`);
    if (ids.has(entry.id)) throw new Error(`${entriesKey} ID 重复：${entry.id}`);
    ids.add(entry.id);
    assertString(entry.root, `${entry.id}.root`);
    if (!entry.root.startsWith(`${workspace}/`)) throw new Error(`${entry.id}.root 跨层：${entry.root}`);
    validateRunner(entry.runner, entry.id);
    if (!existsSync(resolve(repoRoot, entry.runner.cwd))) throw new Error(`${entry.id}.runner.cwd 不存在`);
    if (workspace === 'test-case') {
      if (!entry.target || !['module', 'interface', 'feature', 'bug', 'benchmark-framework'].includes(entry.target.kind)) {
        throw new Error(`${entry.id}.target.kind 非法`);
      }
      assertString(entry.target.path, `${entry.id}.target.path`);
    } else {
      assertString(entry.capability, `${entry.id}.capability`);
      if (!Array.isArray(entry.profiles) || entry.profiles.length === 0) throw new Error(`${entry.id}.profiles 不能为空`);
      assertString(entry.reportDir, `${entry.id}.reportDir`);
    }
  }
  return { entries, assetCount: validateMigrationMap(repoRoot, manifest, workspace) };
}

function formatEntry(entry, workspace) {
  if (workspace === 'test-case') return `${entry.id}\t${entry.target.kind}\t${entry.target.path}`;
  return `${entry.id}\t${entry.capability}\t${entry.profiles.join(',')}`;
}

export function runWorkspaceCli({ moduleUrl, workspace, manifestRelative, entriesKey, selectorName, afterValidate }) {
  try {
    const repoRoot = repoRootFrom(moduleUrl);
    const manifest = readJson(resolve(repoRoot, manifestRelative));
    const { command, options, forwarded } = parseArgs(process.argv.slice(2));
    const { entries, assetCount } = validateWorkspaceManifest({ repoRoot, manifest, workspace, entriesKey });

    if (command === 'help') {
      console.log(`Usage: node ${manifestRelative.replace('manifest.json', 'cli.mjs')} list|validate|run [--${selectorName} id] [--profile id] [-- ...args]`);
      return;
    }
    if (command === 'validate') {
      afterValidate?.({ repoRoot, manifest, entries, assetCount });
      console.log(`${workspace}: valid (${entries.length} entries, ${assetCount} mapped assets)`);
      return;
    }
    if (command === 'list') {
      for (const entry of entries) console.log(formatEntry(entry, workspace));
      return;
    }
    if (command !== 'run') throw new Error(`未知命令：${command}`);

    const selector = options.get(selectorName);
    if (!selector) throw new Error(`run 需要 --${selectorName}`);
    const entry = entries.find(item => item.id === selector);
    if (!entry) throw new Error(`不存在的 ${selectorName}：${selector}`);
    const profile = options.get('profile');
    if (workspace === 'benchmark' && profile && !entry.profiles.includes(profile)) {
      throw new Error(`${entry.id} 不支持 profile：${profile}`);
    }
    const args = [...entry.runner.args];
    if (profile) args.push(entry.runner.profileArg ?? '--profile', profile);
    args.push(...forwarded);
    const result = spawnSync(entry.runner.command, args, {
      cwd: resolve(repoRoot, entry.runner.cwd),
      env: { ...process.env, MINECLAW_REPO_ROOT: repoRoot },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`[${workspace}] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
