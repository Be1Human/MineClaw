import type { Express, Request } from 'express';
import { extname } from 'node:path';
import { ResourcePackError, type ResourcePackSourceKind } from './types.js';
import type { ResourcePackStore } from './resourcePackStore.js';
import type { ResourcePackLimits } from './types.js';

export function registerResourcePackRoutes(
  app: Express,
  store: ResourcePackStore,
  limits: () => ResourcePackLimits,
): void {
  app.get('/api/resource-packs', (_req, res) => {
    res.json({ packs: store.list() });
  });

  app.get('/api/resource-packs/:id', (req, res) => {
    const descriptor = store.get(req.params.id);
    if (!descriptor) { res.status(404).json({ error: 'resource pack not found' }); return; }
    res.json(descriptor);
  });

  app.post('/api/resource-packs', async (req, res) => {
    if (!isZipContentType(req)) {
      res.status(415).json({ error: 'Content-Type must be application/zip' });
      return;
    }
    try {
      const archive = await readPackBody(req, limits().maxPackBytes);
      const source = parseSource(req.query.source);
      const descriptor = store.import({
        archive,
        fileName: queryString(req.query.fileName) ?? 'resource-pack.zip',
        minecraftVersion: queryString(req.query.minecraftVersion) ?? '',
        source,
        licenseId: queryString(req.query.licenseId),
        distributable: queryString(req.query.distributable) === 'true',
      });
      res.status(201).json(descriptor);
    } catch (error) {
      if (error instanceof ResourcePackError) {
        res.status(resourcePackStatus(error)).json({ error: error.message, code: error.code });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/resource-packs/:id/files/{*filePath}', (req, res) => {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
    try {
      const bytes = store.readFile(req.params.id, filePath);
      if (!bytes) { res.status(404).end(); return; }
      res.type(mimeFor(filePath));
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(Buffer.from(bytes));
    } catch (error) {
      if (error instanceof ResourcePackError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      res.status(400).json({ error: 'invalid resource pack path' });
    }
  });
}

async function readPackBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ResourcePackError('PACK_TOO_LARGE', `archive exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new ResourcePackError('PACK_TOO_LARGE', `archive exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function parseSource(value: unknown): ResourcePackSourceKind {
  const source = queryString(value) ?? 'local-import';
  if (source === 'local-import' || source === 'server-pack' || source === 'mineclaw-original') return source;
  throw new ResourcePackError('PACK_INVALID_METADATA', `invalid resource pack source: ${source}`);
}

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim() || undefined;
  return undefined;
}

function isZipContentType(req: Request): boolean {
  const value = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  return value === 'application/zip' || value === 'application/octet-stream';
}

function resourcePackStatus(error: ResourcePackError): number {
  return error.code === 'PACK_TOO_LARGE' || error.code === 'PACK_EXPANDED_TOO_LARGE'
    ? 413
    : 400;
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.json':
    case '.mcmeta': return 'application/json';
    case '.txt':
    case '.md': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
