import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ResourcePackStore } from './resourcePackStore.js';
import type { ResourcePackDescriptor } from './types.js';

export const BUILTIN_OPEN_BLOCK_PACK_FILE = 'mineclaw-open-blocks.zip';

export function seedBuiltinResourcePack(
  store: ResourcePackStore,
  archivePath: string,
): ResourcePackDescriptor {
  if (!existsSync(archivePath)) {
    throw new Error(`built-in resource pack is missing: ${archivePath}`);
  }
  const descriptor = store.import({
    archive: readFileSync(archivePath),
    fileName: basename(archivePath),
    minecraftVersion: '1.21',
    source: 'mineclaw-original',
    licenseId: 'MIT',
    distributable: true,
  });
  for (const cached of store.list()) {
    if (
      cached.id !== descriptor.id
      && cached.source === 'mineclaw-original'
      && cached.fileName === BUILTIN_OPEN_BLOCK_PACK_FILE
    ) {
      store.removeCached(cached.id);
    }
  }
  return descriptor;
}
