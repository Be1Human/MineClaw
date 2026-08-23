import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runner = resolve(repoRoot, 'benchmark/capability/runner.mjs');
const scenarioRunner = resolve(repoRoot, '.agents/skills/minecraft-test-environment/scripts/apply-scenario.mjs');

function readCatalog(suite: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, `benchmark/capability/${suite}/catalog.json`), 'utf8'));
}

test('短程能力目录完整覆盖 TC-SC-01 至 TC-SC-21', () => {
  const catalog = readCatalog('short');
  assert.deepEqual(catalog.cases.map((item: { id: string }) => item.id),
    Array.from({ length: 21 }, (_, index) => `TC-SC-${String(index + 1).padStart(2, '0')}`));
});

test('TC-SC-21 普通世界农田归仓场景通过环境安全预检', () => {
  const output = execFileSync(process.execPath, [scenarioRunner,
    '--server-dir', resolve(repoRoot, 'mc-server'),
    '--scenario', 'short-harvest-wheat-to-home-chest',
    '--bot', 'LanYi',
    '--owner', 'cloudboyboy',
    '--dry-run'], { cwd: repoRoot, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.validated, true);
  assert.equal(report.commandCount, 47);
  assert.ok(report.commands.includes('setworldspawn 151 69 -304'));
  assert.ok(report.commands.includes('tp cloudboyboy 153.5 69 -304.5'));
});

test('战斗能力目录保留五个独立场景', () => {
  const catalog = readCatalog('combat-survival');
  assert.equal(catalog.cases.length, 5);
  assert.equal(new Set(catalog.cases.map((item: { id: string }) => item.id)).size, 5);
});

test('能力预检明确返回 capabilityPassed=null', () => {
  const output = execFileSync(process.execPath, [runner, '--suite', 'short', '--profile', 'canary', '--preflight'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const report = JSON.parse(output);
  assert.equal(report.outcome, 'preflight-passed');
  assert.equal(report.capabilityPassed, null);
  assert.equal(report.cases.length, 1);
});

test('未进入真服闭环时能力 Runner 必须失败关闭', () => {
  const result = spawnSync(process.execPath, [runner, '--suite', 'short', '--profile', 'canary'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不能把预检当作能力通过/u);
});
