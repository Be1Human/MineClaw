import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasIcon } from '../../../../apps/minecraft-companion/web/src/icons/iconDefinitions.js';

const sourceRoot = fileURLToPath(
  new URL('../../../../apps/minecraft-companion/web/src', import.meta.url),
);

function listVueFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listVueFiles(path) : extname(entry.name) === '.vue' ? [path] : [];
  });
}

function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const vueSources = listVueFiles(sourceRoot).map((path) => ({
  path,
  name: relative(sourceRoot, path),
  source: readFileSync(path, 'utf8'),
}));

test('Vue user interfaces do not use emoji or legacy glyphs as icons', () => {
  const violations = [];
  const forbidden = /\p{Extended_Pictographic}|&#(?:x[0-9a-f]+|\d+);|[✓✕♥↶↗⌫▣⊙✎]/giu;

  for (const file of vueSources) {
    const visibleSource = withoutComments(file.source);
    for (const match of visibleSource.matchAll(forbidden)) {
      violations.push(`${file.name}: ${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('every Vue McIcon consumer imports the shared renderer', () => {
  const invalidConsumers = vueSources
    .filter((file) => file.source.includes('<McIcon'))
    .filter((file) => !/import\s+McIcon\s+from\s+['"][^'"]*\/icons\/McIcon\.vue['"]/.test(file.source))
    .map((file) => file.name);

  assert.deepEqual(invalidConsumers, []);
});

test('literal icon names used by Vue components exist in the registry', () => {
  const missing = [];

  for (const file of vueSources) {
    const names = [
      ...Array.from(file.source.matchAll(/<McIcon\b[^>]*?(?<!:)name="([a-z0-9-]+)"/g), (match) => match[1]),
      ...Array.from(file.source.matchAll(/iconName:\s*['"]([a-z0-9-]+)['"]/g), (match) => match[1]),
    ];
    for (const name of names) {
      if (!hasIcon(name)) missing.push(`${file.name}: ${name}`);
    }
  }

  assert.deepEqual(missing, []);
});

test('the web package does not add a third-party UI icon dependency', () => {
  const packageJson = readFileSync(join(sourceRoot, '..', 'package.json'), 'utf8');
  assert.doesNotMatch(packageJson, /lucide|heroicons|fontawesome|iconify|bootstrap-icons/i);
});
