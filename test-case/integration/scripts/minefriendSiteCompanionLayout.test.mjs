import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const siteRoot = resolve(publicRoot, 'apps', 'minefriend-site');

test('companion introduction separates narrative heading from evidence columns', async () => {
  const main = await readFile(resolve(siteRoot, 'src', 'main.js'), 'utf8');
  const section = main.match(/<section class="companion-details[\s\S]*?<\/section>/)?.[0] ?? '';

  assert.match(section, /<div class="details-heading reveal">[\s\S]*?<h2 id="companion-title">先认识她这个人，<br \/>再和她一起出发。<\/h2>[\s\S]*?<p class="details-lead">/);
  assert.match(section, /<div class="details-layout">\s*<div class="details-copy reveal">\s*<div class="detail-list"/);
  assert.doesNotMatch(section, /<div class="details-copy reveal">[\s\S]*?class="section-kicker"/);
});

test('desktop companion evidence columns share a top baseline', async () => {
  const css = await readFile(resolve(siteRoot, 'src', 'style.css'), 'utf8');

  assert.match(css, /\.details-heading \{[^}]*grid-template-columns: minmax\(0, 1\.25fr\) minmax\(320px, 0\.75fr\)[^}]*align-items: end/);
  assert.match(css, /\.details-layout \{[^}]*grid-template-columns: minmax\(320px, 0\.72fr\) minmax\(0, 1\.28fr\)[^}]*align-items: start/);
  assert.match(css, /\.detail-list \{[^}]*margin-top: 0/);
  assert.doesNotMatch(css, /\.details-layout \{[^}]*align-items: center/);
});

test('companion narrative and evidence collapse below 980px', async () => {
  const css = await readFile(resolve(siteRoot, 'src', 'style.css'), 'utf8');
  const responsive = css.match(/@media \(max-width: 980px\) \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(responsive, /\.details-heading \{ grid-template-columns: 1fr;/);
  assert.match(responsive, /\.details-layout \{ grid-template-columns: 1fr;/);
  assert.match(responsive, /\.details-capture \{ width: min\(100%, 760px\); \}/);
});
