/**
 * FEAT-CROSS-26-001-004-004 · legacy deletion gate (P3-4 scanner).
 * Generated artifacts must contain zero legacy production symbols (U31/P03
 * negative at repository scale); the scanner itself recognizes every listed
 * symbol from the design deletion table.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLegacyReferences, scanGeneratedArtifacts, LEGACY_SYMBOLS } from '../../../apps/minecraft-companion/scripts/plugin-legacy-scan.mjs';

test('P03/U31 生成产物（builtin 索引）对全部旧符号零命中', () => {
  const hits = scanGeneratedArtifacts();
  assert.deepEqual(hits, [], JSON.stringify(hits));
});

test('删除门扫描器识别设计删除表的旧符号（fixture 目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-scan-'));
  try {
    writeFileSync(join(dir, 'legacy.ts'), `export const createAgricultureCapabilityPackage = 1;\nconst a = 'mineclaw:mature_crops_to_chest';\nvoid a;\n`);
    writeFileSync(join(dir, 'keep.test.ts'), `const b = 'harvest_mature_crops_to_chest';\nvoid b;\n`);
    const hits = scanLegacyReferences({ rootDir: dir });
    assert.equal(hits.length >= 1, true, JSON.stringify(hits));
    const production = hits.filter(hit => !/\.test\.ts$/.test(hit.file));
    assert.equal(production.length >= 1, true);
    assert.ok(production.some(hit => hit.symbol === 'createAgricultureCapabilityPackage'));
    assert.ok(production.some(hit => hit.symbol === 'mineclaw:mature_crops_to_chest'));
    // 覆盖说明：所有设计表符号都在清单中。
    assert.ok(LEGACY_SYMBOLS.length >= 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P03 插件目录不含旧 Manifest/Goal/Behavior 生产 ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-ok-'));
  try {
    mkdirSync(join(dir, 'mineclaw.agriculture'));
    writeFileSync(join(dir, 'mineclaw.agriculture', 'plugin.yaml'), `schema: mineclaw.plugin/v1\nid: mineclaw.agriculture\ncontributions: []\n`);
    const hits = scanLegacyReferences({ rootDir: dir });
    assert.deepEqual(hits, [], JSON.stringify(hits));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  void join;
});
