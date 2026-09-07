import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const DEFAULT_RUNTIME_DB_PATH = 'data/v2-memory.db';
const EPHEMERAL_PREFIX = 'mineclaw-v2-runtime-';

/**
 * Owns the lifecycle-consistent locations of stores derived from V2Runtime's
 * primary database. Stores receive only a concrete path; they never decide
 * whether the enclosing Runtime is persistent or ephemeral.
 */
export class RuntimeStorageLayout {
  readonly ephemeral: boolean;
  private readonly dataDirectory: string;
  private ephemeralDirectory: string | null;

  constructor(primaryDbPath?: string) {
    this.ephemeral = primaryDbPath === ':memory:';
    this.ephemeralDirectory = this.ephemeral
      ? mkdtempSync(join(tmpdir(), EPHEMERAL_PREFIX))
      : null;
    this.dataDirectory = this.ephemeral
      ? this.ephemeralDirectory!
      : dirname(primaryDbPath ?? DEFAULT_RUNTIME_DB_PATH);
  }

  /** A derived SQLite store always follows the Runtime persistence mode. */
  database(filename: string): string {
    assertLocalName(filename, 'database filename');
    return this.ephemeral ? ':memory:' : join(this.dataDirectory, filename);
  }

  /** A derived file-backed store receives a Runtime-owned local directory. */
  directory(name: string): string {
    assertLocalName(name, 'directory name');
    return join(this.dataDirectory, name);
  }

  /** Idempotently removes the temporary root created only for an in-memory Runtime. */
  dispose(): void {
    const directory = this.ephemeralDirectory;
    this.ephemeralDirectory = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function assertLocalName(value: string, label: string): void {
  if (!value || basename(value) !== value || value === '.' || value === '..') {
    throw new Error(`runtime_storage_invalid_${label.replace(/\s+/g, '_')}`);
  }
}
