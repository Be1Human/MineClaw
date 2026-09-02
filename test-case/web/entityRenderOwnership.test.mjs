import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldRenderSimpleEntities } from '../../apps/minecraft-companion/web/src/lib/authentic/entityRenderOwnership.js';

test('BUG-WEBUI-30 | 真实实体激活后，简略实体层不再取得非 Bot 实体的显示权', () => {
  assert.equal(shouldRenderSimpleEntities('simple'), true);
  assert.equal(shouldRenderSimpleEntities(null), true, '真实首帧前仍显示简略回退');
  assert.equal(shouldRenderSimpleEntities('authentic'), false);
});

test('BUG-WEBUI-30 | 组件将简略实体收进专属图层，并按当前渲染器门控更新', () => {
  const source = readFileSync(new URL('../../apps/minecraft-companion/web/src/components/PerceptionScene3D.vue', import.meta.url), 'utf8');
  assert.match(source, /simpleEntityGroup = new THREE\.Group\(\)/);
  assert.match(source, /simpleEntityGroup\?\.add\(group\)/);
  assert.match(source, /shouldRenderSimpleEntities\(worldRendererRegistry\?\.activeId\)/);
  assert.match(source, /simpleEntityGroup\?\.remove\(group\)/);
});
