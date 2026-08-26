import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const appRoot = resolve(publicRoot, 'apps', 'minecraft-companion');
const webRoot = resolve(appRoot, 'web', 'src');
const skinsRoot = resolve(webRoot, 'assets', 'skins');

async function source(path) {
  return readFile(resolve(webRoot, path), 'utf8');
}

test('07-lanyi is the only bundled skin and is a valid 64x64 PNG', async () => {
  assert.deepEqual(await readdir(skinsRoot), ['07-lanyi.png']);

  const png = await readFile(resolve(skinsRoot, '07-lanyi.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
});

test('all default skin consumers use 07-lanyi with saved textures taking priority', async () => {
  const character = await source('components/McCharacter.vue');
  const head = await source('components/McHead.vue');
  const pet = await source('components/DesktopPet3D.vue');
  const editor = await source('components/SkinEditor.vue');

  for (const component of [character, head, pet, editor]) {
    assert.match(component, /import defaultSkin from '\.\.\/assets\/skins\/07-lanyi\.png';/);
  }

  assert.match(character, /const url = props\.texture \|\| defaultSkin;/);
  assert.match(head, /img\.src = props\.texture \|\| defaultSkin;/);
  assert.match(pet, /image\.src=props\.texture\|\|defaultSkin;/);
  assert.match(editor, /img\.src = url \|\| defaultSkin;/);
});

test('the built-in preset and empty-model fallback match the slim lanyi skin', async () => {
  const app = await source('App.vue');
  const desktopPet = await source('DesktopPet.vue');
  const petRenderer = await source('components/DesktopPet3D.vue');
  const editor = await source('components/SkinEditor.vue');

  assert.match(editor, /const presetNames = \{ '07-lanyi': '蓝衣' \};/);
  assert.match(editor, /import McHead from '\.\/McHead\.vue';/);
  assert.match(editor, /initModel: \{ type: String, default: 'slim' \}/);
  assert.match(editor, /function usePreset\(p\) \{\s*model\.value = 'slim';/);
  assert.doesNotMatch(editor, /01-forest|02-ocean|03-ember|04-ninja|05-knight|06-sakura/);

  assert.match(app, /selectedProfile\.value\?\.skinModel \|\| 'slim'/);
  assert.match(desktopPet, /profile\.skinModel \|\| 'slim'/);
  assert.match(petRenderer, /model:\{type:String,default:'slim'\}/);
});

test('removed default and preset names have no remaining product references', async () => {
  const files = [
    'App.vue',
    'DesktopPet.vue',
    'components/McCharacter.vue',
    'components/McHead.vue',
    'components/DesktopPet3D.vue',
    'components/SkinEditor.vue',
  ];
  const combined = (await Promise.all(files.map(source))).join('\n');

  assert.doesNotMatch(combined, /default-skin\.png/);
  assert.doesNotMatch(combined, /01-forest|02-ocean|03-ember|04-ninja|05-knight|06-sakura/);
});
