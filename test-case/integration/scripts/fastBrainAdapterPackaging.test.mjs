import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginIndex } from '../../../apps/minecraft-companion/scripts/plugin-index.mjs';

const kernel = fileURLToPath(new URL('../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/', import.meta.url));

test('FastBrain production package regenerates byte-consistent static factories and embedded protocol content', () => {
  const output = mkdtempSync(join(tmpdir(), 'mineclaw-fastbrain-package-'));
  try {
    const outManifest = join(output, 'manifest.json');
    const outIndex = join(output, 'index.ts');
    buildPluginIndex({ outManifest, outIndex });
    const generated = JSON.parse(readFileSync(outManifest, 'utf8'));
    const released = JSON.parse(readFileSync(join(kernel, 'builtin-manifest.generated.json'), 'utf8'));
    delete generated.generatedAt;
    delete released.generatedAt;
    assert.deepEqual(generated, released);
    const factories = readFileSync(outIndex, 'utf8');
    assert.equal(factories, readFileSync(join(kernel, 'builtin-index.generated.ts'), 'utf8'));
    assert.match(factories, /createMineclawFastbrainPlugin/);
    assert.match(factories, /fastbrain\/protocol\.md/);
    const pkg = generated.plugins.find(value => value.pluginId === 'mineclaw.fastbrain');
    assert.equal(pkg.manifest.kind, 'domain');
    assert.deepEqual(pkg.manifest.permissions, []);
    assert.deepEqual(pkg.manifest.contributions.map(value => value.kind), ['knowledge']);
    assert.doesNotMatch(JSON.stringify(pkg), /system\.adapter|system\.atomic|atomicCatalog/);
  } finally { rmSync(output, { recursive: true, force: true }); }
});
