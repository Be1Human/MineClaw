import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const webRoot = resolve(publicRoot, 'apps', 'minecraft-companion', 'web', 'src');

async function source(path) {
  return readFile(resolve(webRoot, path), 'utf8');
}

test('App passes the selected profile skin contract into the perception scene', async () => {
  const app = await source('App.vue');

  assert.match(app, /<PerceptionScene3D[\s\S]*:worldState="currentWorldState"[\s\S]*:skinTexture="selectedSkinTexture"[\s\S]*:skinModel="selectedSkinModel"/);
  assert.match(app, /selectedProfile\.value\?\.skinTexture \|\| ''/);
  assert.match(app, /selectedProfile\.value\?\.skinModel \|\| 'slim'/);
});

test('the perception scene renders the bot with PlayerObject and the lanyi fallback', async () => {
  const scene = await source('components/PerceptionScene3D.vue');
  const botMarker = scene.slice(
    scene.indexOf('function createBotMarker()'),
    scene.indexOf('function applyBotSkinModel()'),
  );

  assert.match(scene, /import \{ PlayerObject \} from 'skinview3d';/);
  assert.match(scene, /import defaultSkin from '\.\.\/assets\/skins\/07-lanyi\.png';/);
  assert.match(scene, /skinTexture: \{ type: String, default: '' \}/);
  assert.match(scene, /skinModel: \{ type: String, default: 'slim' \}/);
  assert.match(scene, /botPlayer = new PlayerObject\(\);/);
  assert.match(scene, /props\.skinTexture \|\| defaultSkin/);
  assert.match(scene, /if \(allowFallback\) loadBotSkinSource\(defaultSkin, loadVersion, false\);/);
  assert.doesNotMatch(botMarker, /const bodyMat = new THREE\.MeshPhongMaterial/);
  assert.doesNotMatch(botMarker, /const headMat = new THREE\.MeshPhongMaterial/);
});

test('skin changes are race-safe, model-aware, and release GPU textures', async () => {
  const scene = await source('components/PerceptionScene3D.vue');

  assert.match(scene, /loadVersion !== botSkinLoadVersion/);
  assert.match(scene, /props\.skinModel === 'slim' \? 'slim' : 'default'/);
  assert.match(scene, /watch\(\(\) => props\.skinTexture, loadBotSkin\);/);
  assert.match(scene, /watch\(\(\) => props\.skinModel, applyBotSkinModel\);/);
  assert.match(scene, /previousTexture\?\.dispose\(\);/);
  assert.match(scene, /botSkinTexture\?\.dispose\(\);/);
});

test('the skinned bot keeps world pose and existing navigation markers', async () => {
  const scene = await source('components/PerceptionScene3D.vue');

  assert.match(scene, /botMesh\.position\.set\(bp\.x, bp\.y, bp\.z\);/);
  assert.match(scene, /mineflayerYawBasis, mineflayerYawToThreeRotation/);
  assert.match(scene, /botMesh\.rotation\.y = mineflayerYawToThreeRotation\(ws\.self\.yaw, '\+z'\);/);
  assert.match(scene, /const \{ forward \} = mineflayerYawBasis\(ws\.self\.yaw\);/);
  assert.match(scene, /group\.rotation\.y = mineflayerYawToThreeRotation\(entity\.yaw, entity\.category === 'player' \? '\+z' : '-z'\);/);
  assert.match(scene, /new THREE\.RingGeometry\(0\.3, 0\.6, 24\)/);
  assert.match(scene, /new THREE\.RingGeometry\(0\.7, 1\.1, 32\)/);
  assert.match(scene, /botDirectionMesh = new THREE\.Mesh\(dirGeom, dirMat\);/);
  assert.match(scene, /controls\.target\.copy\(botCenter\);/);
});
