import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadCapabilityResourcePackage,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityManifestLoader.js';
import {
  DomainKnowledgeRegistry,
  loadDomainKnowledge,
  loadDomainKnowledgeFile,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/domainKnowledge.js';

const agricultureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../apps/minecraft-companion/capability-packages/agriculture',
);

test('FEAT-CROSS-19 · YAML manifest and Markdown Knowledge load as separate resources', () => {
  const resources = loadCapabilityResourcePackage(agricultureDir);
  assert.equal(resources.manifest.id, 'agriculture.harvest_mature_crops_to_chest');
  assert.deepEqual(resources.manifest.skills, ['成熟农田归仓']);
  assert.deepEqual(resources.manifest.knowledge, [
    'agriculture:wheat-maturity',
    'agriculture:harvest-to-chest',
  ]);
  assert.deepEqual(resources.manifest.requires.atomics, ['move_to', 'dig', 'deposit']);
  assert.deepEqual(resources.knowledgeDocuments.map(value => value.id), [
    'agriculture:harvest-to-chest',
    'agriculture:wheat-maturity',
  ]);
  assert.equal(resources.knowledgeDocuments.every(value => value.sourcePath.endsWith('.md')), true);
});

test('FEAT-CROSS-19 · Domain Knowledge search/get is versioned and budget bounded', () => {
  const resources = loadCapabilityResourcePackage(agricultureDir);
  const registry = new DomainKnowledgeRegistry(resources.knowledgeDocuments);
  const result = registry.search({ query: '小麦成熟', limit: 6 });
  assert.equal(result[0]?.id, 'agriculture:wheat-maturity');
  assert.equal('body' in (result[0] ?? {}), false);
  const loaded = registry.get({ ref: result[0]!.ref, expectedVersion: result[0]!.version });
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.match(loaded.document.body, /age=7/);
  assert.deepEqual(registry.get({ ref: result[0]!.ref, expectedVersion: 'sha256:stale' }), {
    ok: false,
    reason: 'stale',
    ref: result[0]!.ref,
    expectedVersion: 'sha256:stale',
    actualVersion: result[0]!.version,
  });
  assert.equal(registry.get({ ref: result[0]!.ref, maxTokens: 1 }).ok, false);
});

test('FEAT-CROSS-19 · malformed, duplicate, missing and escaping Knowledge fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-capability-'));
  try {
    const knowledgeDir = join(root, 'knowledge');
    mkdirSync(knowledgeDir);
    writeFileSync(join(knowledgeDir, 'valid.md'), knowledge('test:valid', '有效知识'));
    writeFileSync(join(root, 'capability.yaml'), manifest(['test:missing']));
    assert.throws(() => loadCapabilityResourcePackage(root), /unavailable Knowledge: test:missing/);

    writeFileSync(join(knowledgeDir, 'duplicate.md'), knowledge('test:valid', '重复知识'));
    assert.throws(() => new DomainKnowledgeRegistry(loadDomainKnowledge(knowledgeDir)), /duplicate domain knowledge id/);

    const outside = join(root, '..', `outside-${Date.now()}.md`);
    writeFileSync(outside, knowledge('test:outside', '越界知识'));
    try {
      assert.throws(() => loadDomainKnowledgeFile(knowledgeDir, outside), /escapes root/);
    } finally {
      rmSync(outside, { force: true });
    }

    writeFileSync(join(knowledgeDir, 'broken.md'), '# missing frontmatter');
    assert.throws(() => loadDomainKnowledge(knowledgeDir), /frontmatter is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function knowledge(id: string, title: string): string {
  return `---\nid: ${id}\ntitle: ${title}\nsummary: 用于加载边界测试\ntags: [test, knowledge]\n---\n\n正文。\n`;
}

function manifest(knowledgeIds: string[]): string {
  return `schema: mineclaw/capability-manifest@1
id: test.capability
version: 1
description: test
goalTargets:
  - kind: item
    registryId: mineclaw:test
    aliases: [测试]
    taskFamilies: [test]
    successCriteria:
      - type: predicate
        predicate: test.done
skills: [测试技能]
knowledge: [${knowledgeIds.join(', ')}]
requires:
  atomics: [move_to]
`;
}
