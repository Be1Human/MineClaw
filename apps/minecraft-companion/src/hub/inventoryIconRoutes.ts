import type { Express } from 'express';
import type { ResourcePackStore } from './resourcePacks/resourcePackStore.js';

const ICON_KINDS = ['item', 'block'] as const;

export function readInventoryIcon(
  store: ResourcePackStore,
  builtinPackId: string | null,
  name: string,
): Uint8Array | null {
  if (!builtinPackId) return null;
  for (const kind of ICON_KINDS) {
    const bytes = store.readFile(
      builtinPackId,
      `assets/minecraft/textures/${kind}/${name}.png`,
    );
    if (bytes) return bytes;
  }
  return null;
}

export function registerInventoryIconRoutes(
  app: Express,
  store: ResourcePackStore,
  builtinPackId: string | null,
): void {
  app.get('/api/icon/:name', (req, res) => {
    const name = String(req.params.name ?? '').replace(/^minecraft:/, '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) {
      res.status(400).end();
      return;
    }

    const bytes = readInventoryIcon(store, builtinPackId, name);
    if (!bytes) {
      res.status(404).end();
      return;
    }

    res.type('png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(bytes));
  });
}
