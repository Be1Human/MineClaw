import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { inspectResourcePack, normalizePackPath } from './resourcePackPolicy.js';
import type {
  ResourcePackDescriptor,
  ResourcePackImportInput,
  ResourcePackLimits,
} from './types.js';

export class ResourcePackStore {
  private readonly root: string;

  constructor(
    dataDir: string,
    private readonly limits: () => ResourcePackLimits,
  ) {
    this.root = resolve(dataDir, 'resource-packs');
    mkdirSync(this.root, { recursive: true });
  }

  import(input: ResourcePackImportInput): ResourcePackDescriptor {
    const inspected = inspectResourcePack(input, this.limits());
    const target = this.packRoot(inspected.descriptor.id);
    const existing = this.get(inspected.descriptor.id);
    if (existing?.sha256 === inspected.descriptor.sha256) return existing;

    const temporary = mkdtempSync(join(this.root, '.import-'));
    try {
      const filesRoot = join(temporary, 'files');
      mkdirSync(filesRoot, { recursive: true });
      for (const [path, bytes] of inspected.files) {
        const file = this.resolveFileWithin(filesRoot, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      writeFileSync(
        join(temporary, 'descriptor.json'),
        `${JSON.stringify(inspected.descriptor, null, 2)}\n`,
        'utf8',
      );
      if (existsSync(target)) return this.requireDescriptor(target);
      renameSync(temporary, target);
      return inspected.descriptor;
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
  }

  list(): ResourcePackDescriptor[] {
    if (!existsSync(this.root)) return [];
    const packs: ResourcePackDescriptor[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.import-')) continue;
      const descriptor = this.get(entry.name);
      if (descriptor) packs.push(descriptor);
    }
    return packs.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  }

  get(id: string): ResourcePackDescriptor | null {
    if (!/^pack-[a-f0-9]{16}$/.test(id)) return null;
    const target = this.packRoot(id);
    if (!existsSync(join(target, 'descriptor.json'))) return null;
    try {
      return this.requireDescriptor(target);
    } catch {
      return null;
    }
  }

  readFile(id: string, path: string): Uint8Array | null {
    if (!this.get(id)) return null;
    const filesRoot = join(this.packRoot(id), 'files');
    const file = this.resolveFileWithin(filesRoot, normalizePackPath(path));
    if (!existsSync(file)) return null;
    return readFileSync(file);
  }

  private requireDescriptor(target: string): ResourcePackDescriptor {
    return JSON.parse(readFileSync(join(target, 'descriptor.json'), 'utf8')) as ResourcePackDescriptor;
  }

  private packRoot(id: string): string {
    const target = resolve(this.root, id);
    if (relative(this.root, target).startsWith('..')) throw new Error('resource pack target escaped cache root');
    return target;
  }

  private resolveFileWithin(root: string, path: string): string {
    const target = resolve(root, ...path.split('/'));
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root) === target) {
      throw new Error('resource pack file escaped cache root');
    }
    return target;
  }
}
