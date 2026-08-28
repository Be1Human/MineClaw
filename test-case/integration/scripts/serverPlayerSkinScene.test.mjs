import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const companionRoot = resolve(publicRoot, 'apps', 'minecraft-companion');

async function source(path) {
  return readFile(resolve(companionRoot, path), 'utf8');
}

test('WEBUI-001 | adapter and perception contracts expose optional server skin fields', async () => {
  const rawTypes = await source('src/bot/adapter/types.ts');
  const entityTypes = await source('src/bot/v2/types.ts');
  const adapter = await source('src/bot/mineflayer/MineflayerGameAdapter.ts');
  const pipeline = await source('src/bot/v2/perception/pipeline.ts');

  assert.match(rawTypes, /skinUrl\?: string;/);
  assert.match(rawTypes, /skinModel\?: 'classic' \| 'slim';/);
  assert.match(entityTypes, /skinUrl\?: string;/);
  assert.match(entityTypes, /skinModel\?: 'classic' \| 'slim';/);
  assert.match(adapter, /bot\.players\?\.\[username\][\s\S]*?skinData/);
  assert.match(adapter, /skinModel: skinData\.model === 'slim' \? 'slim' as const : 'classic' as const/);
  assert.match(pipeline, /\.\.\.\(e\.skinUrl \? \{ skinUrl: e\.skinUrl \} : \{\}\)/);
  assert.match(pipeline, /\.\.\.\(e\.skinModel \? \{ skinModel: e\.skinModel \} : \{\}\)/);
});

test('WEBUI-001 | simple perception players use PlayerObject and keep spatial markers', async () => {
  const scene = await source('web/src/components/PerceptionScene3D.vue');
  const playerBranch = scene.slice(
    scene.indexOf("if (entity.category === 'player')"),
    scene.indexOf("} else if (entity.category === 'hostile')"),
  );

  assert.match(scene, /function createPlayerEntityVisual\(group, entity\)/);
  assert.match(scene, /player = new PlayerObject\(\)/);
  assert.match(scene, /player\.name = 'serverSkinPlayer'/);
  assert.match(playerBranch, /createPlayerEntityVisual\(group, entity\)/);
  assert.doesNotMatch(playerBranch, /new THREE\.BoxGeometry/);
  assert.match(scene, /new THREE\.RingGeometry\(0\.4, 0\.7, 24\)/);
  assert.match(scene, /new THREE\.CylinderGeometry\(0\.08, 0\.08, 6, 8\)/);
  assert.match(scene, /group\.position\.set\(entity\.position\.x, entity\.position\.y, entity\.position\.z\)/);
  assert.match(scene, /group\.rotation\.y = -entity\.yaw/);
});

test('WEBUI-001 | server skins are model-aware, HTTPS-normalized, and fall back to lanyi', async () => {
  const scene = await source('web/src/components/PerceptionScene3D.vue');

  assert.match(scene, /replace\(\/\^http:\\\/\\\/textures\\\.minecraft\\\.net\\\//);
  assert.match(scene, /entity\.skinModel === 'slim' \? 'slim'/);
  assert.match(scene, /source === defaultSkin \? 'slim' : 'default'/);
  assert.match(scene, /loadPlayerEntitySkinSource\(state, defaultSkin, 'slim', loadVersion, false\)/);
  assert.match(scene, /image\.crossOrigin = 'anonymous'/);
  assert.match(scene, /state\.player\.skin\.map = nextTexture/);
  assert.match(scene, /state\.player\.skin\.visible = true/);
});

test('WEBUI-001 | skin updates and removals are race-safe and release textures', async () => {
  const scene = await source('web/src/components/PerceptionScene3D.vue');

  assert.match(scene, /loadVersion !== state\.skinLoadVersion/);
  assert.match(scene, /current !== state/);
  assert.match(scene, /const loadVersion = \+\+state\.skinLoadVersion/);
  assert.match(scene, /previousTexture\?\.dispose\(\)/);
  assert.match(scene, /playerSkin\.removed = true/);
  assert.match(scene, /playerSkin\.skinLoadVersion \+= 1/);
  assert.match(scene, /playerSkin\.skinTexture\?\.dispose\(\)/);
  assert.match(scene, /disposeEntityGroup\(group\)/);
});
