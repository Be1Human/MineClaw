/**
 * P02/P03 plugin packaging gate (FEAT-CROSS-26-001-004-002/-004).
 * The generated builtin index must be consistent with source plugins: identity,
 * manifest, code entry, imports, knowledge/skill content — and must be
 * regenerable (idempotent). The legacy capability-package shelf must not appear
 * in the new index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginIndex, PluginIndexError } from '../../../apps/minecraft-companion/scripts/plugin-index.mjs';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-plugins-idx-'));
  return root;
}

function writePlugin(root, id, manifestBody, files = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.yaml'), manifestBody);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test('P02/P03 生成索引：源插件身份/Manifest/入口/imports 一致且幂等', () => {
  const root = fixtureRoot();
  try {
    writePlugin(root, 'mineclaw.scout', `schema: mineclaw.plugin/v1
id: mineclaw.scout
version: 1.2.0
apiVersion: ^2.0.0
kind: domain
entry: index
dependencies: {}
permissions:
  - world.read:bounded-block-snapshot
contributions:
  - kind: observation
    id: mineclaw.scout.observation.nearby
    version: 1.0.0
    factKinds:
      - nearby_blocks
`, {
      'index.ts': `export const createMineclawScoutPlugin = { entryKey: 'plugins/builtin/mineclaw.scout', create: () => [] };\n`,
    });
    const outJson = join(root, 'out.json');
    const outTs = join(root, 'out.ts');
    const result = buildPluginIndex({ scanRoot: root, outManifest: outJson, outIndex: outTs });

    assert.equal(result.plugins.length, 1);
    const [plugin] = result.plugins;
    assert.equal(plugin.pluginId, 'mineclaw.scout');
    assert.equal(plugin.kind, 'domain');
    assert.equal(plugin.entryKey, 'plugins/builtin/mineclaw.scout');
    assert.deepEqual(plugin.imports, []);

    const json = JSON.parse(readFileSync(outJson, 'utf8'));
    assert.equal(json.schema, 'mineclaw.builtin-index/v1');
    assert.equal(json.plugins[0].manifest.id, 'mineclaw.scout');
    assert.equal(json.plugins[0].manifest.entry, 'index');

    const generated = readFileSync(outTs, 'utf8');
    assert.match(generated, /createMineclawScoutPlugin/);
    assert.doesNotMatch(generated, /import\s*\(/); // 禁止动态 import

    // Idempotent regeneration (same output bytes apart from the timestamp).
    const secondJson = join(root, 'out2.json');
    const secondTs = join(root, 'out2.ts');
    buildPluginIndex({ scanRoot: root, outManifest: secondJson, outIndex: secondTs });
    const firstParsed = JSON.parse(readFileSync(outJson, 'utf8'));
    const secondParsed = JSON.parse(readFileSync(secondJson, 'utf8'));
    delete firstParsed.generatedAt;
    delete secondParsed.generatedAt;
    assert.deepEqual(secondParsed, firstParsed);
    assert.equal(readFileSync(secondTs, 'utf8'), readFileSync(outTs, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P02/P03 数据插件无代码入口；坏包 fail-closed 且不写输出', () => {
  const root = fixtureRoot();
  try {
    writePlugin(root, 'mineclaw.facts', `schema: mineclaw.plugin/v1
id: mineclaw.facts
version: 1.0.0
apiVersion: ^2.0.0
kind: data
dependencies: {}
permissions: []
contributions:
  - kind: knowledge
    id: mineclaw.facts.knowledge.crops
    version: 1.0.0
    contentRef: crops.yaml
`, { 'crops.yaml': 'crops:\n  - wheat\n' });
    const outJson = join(root, 'out.json');
    const outTs = join(root, 'out.ts');
    const result = buildPluginIndex({ scanRoot: root, outManifest: outJson, outIndex: outTs });
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].kind, 'data');
    assert.equal(result.plugins[0].entryFile, null);

    // Code entry in a data plugin → whole generation fails closed.
    writePlugin(root, 'mineclaw.bad', `schema: mineclaw.plugin/v1
id: mineclaw.bad
version: 1.0.0
apiVersion: ^2.0.0
kind: data
entry: evil.js
dependencies: {}
permissions: []
contributions:
  - kind: knowledge
    id: mineclaw.bad.knowledge.x
    version: 1.0.0
    contentRef: x.yaml
`);
    assert.throws(() => buildPluginIndex({ scanRoot: root, outManifest: join(root, 'out-bad.json'), outIndex: join(root, 'out-bad.ts') }), PluginIndexError);
    assert.equal(existsSync(join(root, 'out-bad.json')), false, 'fail-closed generation must not write output');
    assert.equal(existsSync(join(root, 'out-bad.ts')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P03 旧 capability-packages 不再出现在新索引（负向）', () => {
  const root = fixtureRoot();
  try {
    writePlugin(root, 'mineclaw.agriculture', `schema: mineclaw.plugin/v1
id: mineclaw.agriculture
version: 1.0.0
apiVersion: ^2.0.0
kind: domain
entry: index
dependencies: {}
permissions:
  - world.read:bounded-block-snapshot
contributions:
  - kind: skill
    id: mineclaw.agriculture.skill.harvest
    version: 1.0.0
    entryRef: harvest.md
`, { 'index.ts': 'export const createAgriculturePlugin = { entryKey: "x", create: () => [] };\n', 'harvest.md': '# harvest\n' });
    const outJson = join(root, 'out.json');
    const outTs = join(root, 'out.ts');
    buildPluginIndex({ scanRoot: root, outManifest: outJson, outIndex: outTs });
    const json = JSON.parse(readFileSync(outJson, 'utf8'));
    const ids = json.plugins.map((plugin) => plugin.pluginId);
    assert.ok(ids.includes('mineclaw.agriculture'));
    // 旧 Manifest 命名空间（mineclaw/capability-manifest@1 与 harvest_mature_crops_to_chest）绝不出现在生成索引。
    const serialized = JSON.stringify(json);
    assert.doesNotMatch(serialized, /capability-manifest@1/);
    assert.doesNotMatch(serialized, /mature_crops_to_chest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
