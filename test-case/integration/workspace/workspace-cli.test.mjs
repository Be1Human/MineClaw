import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateWorkspaceManifest } from '../../../scripts/testing-workspace-cli-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readManifest(relativePath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
}

test('双层 Manifest 与 CLI 在不同 cwd 下保持一致', () => {
  for (const cli of ['test-case/cli.mjs', 'benchmark/cli.mjs']) {
    const rootOutput = execFileSync(process.execPath, [resolve(repoRoot, cli), 'list'], { cwd: repoRoot, encoding: 'utf8' });
    const appOutput = execFileSync(process.execPath, [resolve(repoRoot, cli), 'list'], {
      cwd: resolve(repoRoot, 'apps/minecraft-companion'),
      encoding: 'utf8',
    });
    const docsOutput = execFileSync(process.execPath, [resolve(repoRoot, cli), 'list'], {
      cwd: resolve(repoRoot, 'docs'),
      encoding: 'utf8',
    });
    assert.equal(appOutput, rootOutput);
    assert.equal(docsOutput, rootOutput);
  }
});

test('Benchmark validate 强制总览 HTML 与正式能力定义同步', () => {
  const tsx = resolve(
    repoRoot,
    'apps/minecraft-companion/node_modules/.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  const generator = resolve(repoRoot, 'scripts/generate-benchmark-catalog-doc.ts');
  const current = spawnSync(tsx, [generator, '--check'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.match(current.stdout, /benchmark catalog docs: current/u);

  const missingOutput = resolve(mkdtempSync(resolve(tmpdir(), 'mineclaw-benchmark-overview-')), 'benchmark-overview');
  const stale = spawnSync(tsx, [generator, '--check', '--output-base', missingOutput], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Benchmark 总览已过期/u);
});

test('不存在的集合非零退出并指出 selector', () => {
  const result = spawnSync(process.execPath, [resolve(repoRoot, 'test-case/cli.mjs'), 'run', '--domain', 'missing'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不存在的 domain：missing/u);
});

test('Test Case 合同拒绝重复 ID、跨层 root、缺 runner 和错误 cwd', () => {
  const original = readManifest('test-case/manifest.json');
  const validate = manifest => validateWorkspaceManifest({
    repoRoot,
    manifest,
    workspace: 'test-case',
    entriesKey: 'collections',
  });

  assert.doesNotThrow(() => validate(original));

  const duplicate = structuredClone(original);
  duplicate.collections.push(structuredClone(duplicate.collections[0]));
  assert.throws(() => validate(duplicate), /ID 重复/u);

  const crossLayer = structuredClone(original);
  crossLayer.collections[0].root = 'benchmark/not-allowed';
  assert.throws(() => validate(crossLayer), /跨层/u);

  const missingRunner = structuredClone(original);
  delete missingRunner.collections[0].runner;
  assert.throws(() => validate(missingRunner), /runner 缺失/u);

  const badCwd = structuredClone(original);
  badCwd.collections[0].runner.cwd = 'does/not/exist';
  assert.throws(() => validate(badCwd), /cwd 不存在/u);
});

test('迁移清单拒绝重复资产 ID、跨层目标和漏资产', () => {
  const fakeRoot = mkdtempSync(resolve(tmpdir(), 'mineclaw-workspace-contract-'));
  mkdirSync(resolve(fakeRoot, 'test-case'), { recursive: true });
  mkdirSync(resolve(fakeRoot, 'source'), { recursive: true });
  writeFileSync(resolve(fakeRoot, 'source/a.test.ts'), '');
  const baseMap = {
    schemaVersion: 'mineclaw-testing-migration-map/v1',
    assets: [{ id: 'ASSET-1', layer: 'test-case', oldPath: 'source/a.test.ts', newPath: 'test-case/a.test.ts' }],
  };
  const baseManifest = {
    schemaVersion: 'mineclaw-test-case-manifest/v1',
    workspace: 'test-case',
    migrationMap: 'test-case/migration-map.json',
    collections: [{
      id: 'sample',
      root: 'test-case/sample',
      target: { kind: 'module', path: 'source' },
      runner: { cwd: '.', command: 'node', args: [] },
    }],
  };
  const validate = migration => {
    writeFileSync(resolve(fakeRoot, 'test-case/migration-map.json'), JSON.stringify(migration));
    return validateWorkspaceManifest({ repoRoot: fakeRoot, manifest: baseManifest, workspace: 'test-case', entriesKey: 'collections' });
  };

  assert.doesNotThrow(() => validate(baseMap));
  assert.throws(() => validate({ ...baseMap, assets: [...baseMap.assets, { ...baseMap.assets[0] }] }), /迁移 ID 重复/u);
  assert.throws(() => validate({ ...baseMap, assets: [{ ...baseMap.assets[0], newPath: 'benchmark/a.test.ts' }] }), /跨层写入/u);
  assert.throws(() => validate({ ...baseMap, assets: [{ ...baseMap.assets[0], oldPath: 'source/missing.ts' }] }), /均不存在/u);
});

test('迁移资产只存在于新工作区，旧目录不得回流', () => {
  const migration = readManifest('test-case/migration-map.json');
  assert.equal(migration.assets.length, 596);

  for (const asset of migration.assets) {
    assert.equal(existsSync(resolve(repoRoot, asset.oldPath)), false, `旧路径回流：${asset.oldPath}`);
    assert.equal(existsSync(resolve(repoRoot, asset.newPath)), true, `迁移目标缺失：${asset.newPath}`);
    if (asset.layer === 'test-case') assert.match(asset.newPath, /^test-case\//u);
    if (asset.layer === 'benchmark') assert.match(asset.newPath, /^benchmark\//u);
  }

  const retiredRoots = [
    'apps/minecraft-companion/eval',
    'apps/minecraft-companion/test-scenarios',
  ];
  for (const retiredRoot of retiredRoots) {
    const result = spawnSync('find', [resolve(repoRoot, retiredRoot), '-type', 'f'], { encoding: 'utf8' });
    assert.equal(result.stdout.trim(), '', `废弃目录仍有文件：${retiredRoot}`);
  }
});
