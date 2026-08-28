import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const publicRoot = resolve(import.meta.dirname, '..', '..', '..');
const siteRoot = resolve(publicRoot, 'apps', 'minefriend-site');
const imagesRoot = resolve(siteRoot, 'public', 'media', 'images');

const captures = [
  'live-relationship.jpg',
  'live-perception.jpg',
  'mineclaw-companion-in-world.png',
  'live-inventory.jpg',
  'mineclaw-companion-chat.png',
  'task-workbench-running.jpg',
  'live-role-card.jpg',
  'live-trace.jpg',
];

const previousHashes = new Set([
  '7ea3e59947f013e2', 'cab08ad4697061a2', '76795537d74c31ed', '69f6770e2378f647',
  '316c34c114dd8670', 'f6416d17fb783248', '9a72560aaa2cfbed', '46fb9867ec11751c',
]);

function dimensions(buffer) {
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  assert.equal(buffer[0], 0xff, 'expected JPEG or PNG capture');
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const size = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return [buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5)];
    }
    offset += 2 + size;
  }
  throw new Error('JPEG dimensions not found');
}

test('showcase uses one current cache version for all eight real product captures', async () => {
  const main = await readFile(resolve(siteRoot, 'src', 'main.js'), 'utf8');
  const versions = [];
  for (const name of captures) {
    const match = main.match(new RegExp(`${name.replaceAll('.', '\\.')}\\?v=([0-9-]+)`));
    assert.ok(match, `missing capture reference: ${name}`);
    versions.push(match[1]);
  }
  assert.equal(new Set(versions).size, 1);
});

test('all eight current captures are 1440x900 and differ from the previous batch', async () => {
  for (const name of captures) {
    const buffer = await readFile(resolve(imagesRoot, name));
    assert.deepEqual(dimensions(buffer), [1440, 900], name);
    const shortHash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    assert.equal(previousHashes.has(shortHash), false, `${name} still uses previous capture bytes`);
  }
});
