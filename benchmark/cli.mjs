#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runWorkspaceCli } from '../scripts/testing-workspace-cli-core.mjs';

function validateCatalogOverview({ repoRoot }) {
  const executable = resolve(
    repoRoot,
    'apps/minecraft-companion/node_modules/.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  if (!existsSync(executable)) throw new Error('缺少 tsx，请先安装 apps/minecraft-companion 依赖');

  const result = spawnSync(executable, [resolve(repoRoot, 'scripts/generate-benchmark-catalog-doc.ts'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Benchmark 总览校验失败').trim());
  if (result.stdout) process.stdout.write(result.stdout);
}

runWorkspaceCli({
  moduleUrl: import.meta.url,
  workspace: 'benchmark',
  manifestRelative: 'benchmark/manifest.json',
  entriesKey: 'suites',
  selectorName: 'suite',
  afterValidate: validateCatalogOverview,
});
