import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const siteRoot = resolve(publicRoot, 'apps', 'minefriend-site');

async function source(path) {
  return readFile(resolve(siteRoot, path), 'utf8');
}

test('MineClaw showcase exposes the standalone architecture page from desktop and mobile navigation', async () => {
  const main = await source('src/main.js');
  assert.equal((main.match(/href="\.\/architecture\.html"/g) || []).length >= 3, true);
  assert.match(main, /desktop-nav a\[href\^="#"\]/);
});

test('architecture page maps the current continuous GoalAgent implementation instead of a fixed state machine', async () => {
  const [html, script, data] = await Promise.all([
    source('architecture.html'),
    source('src/architecture.js'),
    source('src/architecture-data.js'),
  ]);
  assert.match(html, /src="\.\/src\/architecture\.js"/);
  for (const text of ['MainBrain', 'GoalAgentPort', 'Session Event Log', 'Production Execution Port', 'Minecraft World']) {
    assert.match(`${script}\n${data}`, new RegExp(text));
  }
  assert.match(data, /goalAgentRoundLoop\.ts/);
  assert.doesNotMatch(`${script}\n${data}`, /Planner → Actor → Critic/);
});

test('architecture source ledger stays public, local and code-mapped', async () => {
  const [data, css, vite] = await Promise.all([
    source('src/architecture-data.js'),
    source('src/architecture.css'),
    source('vite.config.js'),
  ]);
  assert.doesNotMatch(`${data}\n${css}`, /https?:\/\//);
  assert.match(vite, /architecture:\s*fileURLToPath/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /grid-template-columns:\s*1fr/);
});
