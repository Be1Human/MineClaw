import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  appDir,
  resolveNpmCliPath,
} from '../../../apps/minecraft-companion/scripts/electronNative.mjs';

function runNode(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('exit', code => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`node child failed: code=${code}\n${stderr}`));
    });
  });
}

test('start.bat delegates native preparation to electronNative', async () => {
  const launcher = await readFile(resolve(appDir, '..', '..', 'start.bat'), 'utf8');

  assert.doesNotMatch(launcher, /electron-rebuild/i);
  assert.match(launcher, /call npm run electron:dev/i);
  assert.doesNotMatch(launcher, /start "MineClaw"/i);
  assert.doesNotMatch(launcher, /All ready!/i);
});

test('npm recovery uses node with a JavaScript CLI instead of spawning npm.cmd', async () => {
  const npmCliPath = await resolveNpmCliPath({}, process.execPath);

  assert.match(npmCliPath, /npm-cli\.js$/i);
  const result = await runNode([npmCliPath, '--version']);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
