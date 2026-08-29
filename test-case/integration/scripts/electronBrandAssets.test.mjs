import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const appRoot = resolve(publicRoot, 'apps', 'minecraft-companion');

async function text(path) {
  return readFile(resolve(appRoot, path), 'utf8');
}

test('app brand assets stay aligned with the canonical MineClaw mark', async () => {
  const canonical = await readFile(resolve(publicRoot, 'apps', 'minefriend-site', 'public', 'brand', 'mineclaw-mark.svg'));
  const appSvg = await readFile(resolve(appRoot, 'web', 'public', 'brand', 'mineclaw-mark.svg'));
  const png = await readFile(resolve(appRoot, 'build', 'icon.png'));

  assert.deepEqual(appSvg, canonical);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.ok(png.length > 2_000, 'brand PNG should contain rendered image data');
});

test('main and desktop-pet pages use the canonical app favicon', async () => {
  for (const page of ['web/index.html', 'web/desktop-pet.html']) {
    assert.match(await text(page), /<link rel="icon" href="\/brand\/mineclaw-mark\.svg" type="image\/svg\+xml" \/>/);
  }
});

test('the app header renders the official logo instead of the legacy CSS grass block', async () => {
  const app = await text('web/src/App.vue');

  assert.match(app, /<img class="app-brand-logo" src="\/brand\/mineclaw-mark\.svg" alt="" aria-hidden="true" \/>/);
  assert.match(app, /\.app-brand-logo \{ flex:none; width:38px; height:38px; object-fit:contain; \}/);
  assert.match(app, /\.app-brand-logo \{ width: 34px; height: 34px; \}/);
  assert.doesNotMatch(app, /background:#7b5a3a/);
  assert.doesNotMatch(app, /top:11px; left:3px/);
});

test('Electron window and tray share the packaged brand icon with a safe fallback', async () => {
  const main = await text('electron/main.ts');
  const iconModule = await text('electron/appIcon.ts');

  assert.match(main, /const icon = await loadAppIcon\(\)/);
  assert.match(main, /\.\.\.\(icon \? \{ icon \} : \{\}\)/);
  assert.match(main, /new Tray\(icon\.resize\(\{ width: 32, height: 32, quality: 'best' \}\)\)/);
  assert.doesNotMatch(main, /makeIconPng/);
  assert.doesNotMatch(main, /deflateSync/);

  assert.match(iconModule, /join\(resourcesPath, 'brand', 'mineclaw-mark\.png'\)/);
  assert.match(iconModule, /join\(cwd, 'build', 'icon\.png'\)/);
  assert.match(iconModule, /app\.getFileIcon\(process\.execPath/);
  assert.match(iconModule, /应用继续运行/);
});

test('Windows packaging embeds and ships the same generated brand icon', async () => {
  const manifest = JSON.parse(await text('package.json'));
  const electronBuild = await text('scripts/electronBuild.mjs');

  assert.equal(manifest.build.win.icon, 'build/icon.png');
  assert.deepEqual(manifest.build.extraResources, [
    {
      from: 'build/icon.png',
      to: 'brand/mineclaw-mark.png',
    },
    {
      from: 'builtin-packs/mineclaw-open-blocks.zip',
      to: 'resource-packs/mineclaw-open-blocks.zip',
    },
  ]);
  assert.match(electronBuild, /brandAssets\.mjs'\), '--sync'/);
  assert.match(electronBuild, /copyFile\(backupBinding, defaultBindingPath\)/);
});
