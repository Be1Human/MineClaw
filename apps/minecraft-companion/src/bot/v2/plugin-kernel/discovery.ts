/**
 * Plugin discovery (kernel design §5.1/§5.4/§5.5).
 * Sources: first-party static builtin index (release build) and the local
 * data-plugin directory (Knowledge/Skill only, no code entry).
 * Discovery is deterministic and read-only: it produces immutable
 * DiscoveredPluginPackage records for the resolver.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import {
  validatePluginManifest,
  type PluginManifestV1,
  type PluginKind,
} from '../plugin-sdk/manifest.js';
import type { PluginContribution } from '../plugin-sdk/contributions.js';
import type { PluginConstructionContext } from '../plugin-sdk/contracts/scopedContext.js';
import { pluginError } from '../plugin-sdk/errors.js';
import type { PluginIdentity } from '../plugin-sdk/identity.js';

/** Code entry owned by the build index; the factory is the only code path of a package. */
export interface PluginFactory {
  readonly entryKey: string;
  create(context: PluginConstructionContext): readonly PluginContribution[];
}

export interface BuiltinIndexPlugin {
  readonly entryKey: string;
  readonly manifest: Record<string, unknown>;
  readonly factory: PluginFactory;
}

export interface BuiltinPluginIndex {
  readonly byEntryKey: ReadonlyMap<string, BuiltinIndexPlugin>;
}

export interface DiscoveredPluginPackage {
  readonly identity: PluginIdentity;
  readonly manifest: PluginManifestV1;
  readonly factory?: PluginFactory;
  readonly dataContents?: ReadonlyMap<string, string>;
  readonly source: 'builtin' | 'data';
}

export interface PluginDiscoveryInput {
  readonly builtinIndex: BuiltinPluginIndex;
  readonly dataPluginRoot?: string;
  readonly hostApiVersion: string;
  readonly trustedSystemPlugins?: readonly string[];
}

export interface DiscoveryFailure {
  readonly pluginId: string;
  readonly code: string;
  readonly message: string;
}

export interface PluginDiscoveryResult {
  readonly packages: readonly DiscoveredPluginPackage[];
  readonly failures: readonly DiscoveryFailure[];
}

export async function discoverPlugins(input: PluginDiscoveryInput): Promise<PluginDiscoveryResult> {
  const discovered: DiscoveredPluginPackage[] = [];
  const failures: DiscoveryFailure[] = [];
  for (const entry of [...input.builtinIndex.byEntryKey.values()].sort((a, b) => a.entryKey.localeCompare(b.entryKey))) {
    try {
      const manifest = validatePluginManifest(entry.manifest, {
        hostApiVersion: input.hostApiVersion,
        trustedSystemPlugins: input.trustedSystemPlugins,
      });
      discovered.push({
        identity: { pluginId: manifest.id, pluginVersion: manifest.version },
        manifest,
        factory: entry.factory,
        source: 'builtin',
      });
    } catch (error) {
      const failure = toPluginFailureSafe(error);
      failures.push({ pluginId: String((entry.manifest as Record<string, unknown>).id ?? entry.entryKey), code: failure.code, message: failure.message });
    }
  }
  if (input.dataPluginRoot !== undefined) {
    const dataResult = await discoverDataPlugins(input.dataPluginRoot, input.hostApiVersion, input.trustedSystemPlugins);
    discovered.push(...dataResult.packages);
    failures.push(...dataResult.failures);
  }
  return Object.freeze({
    packages: Object.freeze(discovered.sort((a, b) => a.identity.pluginId.localeCompare(b.identity.pluginId))),
    failures: Object.freeze(failures),
  });
}

function toPluginFailureSafe(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: string; message?: string };
  return {
    code: typeof candidate === 'object' && candidate !== null && typeof candidate.code === 'string' ? candidate.code : 'manifest_invalid',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function discoverDataPlugins(root: string, hostApiVersion: string, trustedSystemPlugins?: readonly string[]): Promise<PluginDiscoveryResult> {
  let entries: string[] = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { packages: [], failures: [] };
  }
  const result: DiscoveredPluginPackage[] = [];
  const failures: DiscoveryFailure[] = [];
  for (const id of entries.sort()) {
    try {
      const pluginDir = join(root, id);
      let raw: string;
      try {
        raw = await readFile(join(pluginDir, 'plugin.yaml'), 'utf8');
      } catch {
        throw pluginError('manifest_invalid', `data plugin ${id} is missing plugin.yaml`);
      }
      const rawManifest = parse(raw) as unknown;
      const manifest = validatePluginManifest(rawManifest, { hostApiVersion, trustedSystemPlugins });
      if (manifest.kind !== 'data') {
        throw pluginError('manifest_invalid', `data/plugins must only host data plugins: ${id} is ${manifest.kind}`);
      }
      const contents = await loadDataContents(pluginDir, manifest);
      result.push({
        identity: { pluginId: manifest.id, pluginVersion: manifest.version },
        manifest,
        dataContents: contents,
        source: 'data',
      });
    } catch (error) {
      const failure = toPluginFailureSafe(error);
      failures.push({ pluginId: id, code: failure.code, message: failure.message });
    }
  }
  return { packages: result, failures };
}

async function loadDataContents(pluginDir: string, manifest: PluginManifestV1): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();
  const hashInput: string[] = [];
  for (const contribution of manifest.contributions) {
    if (contribution.kind === 'skill') {
      const file = await readContent(pluginDir, contribution.entryRef);
      contents.set(contribution.entryRef, file);
      hashInput.push(`${contribution.entryRef}:${file}`);
    }
    if (contribution.kind === 'knowledge') {
      const file = await readContent(pluginDir, contribution.contentRef);
      contents.set(contribution.contentRef, file);
      hashInput.push(`${contribution.contentRef}:${file}`);
    }
  }
  if (manifest.integrity) {
    const digest = createHash('sha256').update(hashInput.join('\n')).digest('hex');
    if (digest !== manifest.integrity.contentSha256) {
      throw pluginError('manifest_invalid', `data plugin ${manifest.id} content integrity mismatch (declared ${manifest.integrity.contentSha256}, actual ${digest})`);
    }
  }
  return contents;
}

async function readContent(pluginDir: string, relative: string): Promise<string> {
  const resolved = join(pluginDir, relative);
  if (!resolved.startsWith(pluginDir)) {
    throw pluginError('manifest_invalid', `data plugin content escapes plugin directory: ${relative}`);
  }
  try {
    return await readFile(resolved, 'utf8');
  } catch {
    throw pluginError('manifest_invalid', `data plugin content missing: ${relative}`);
  }
}

export function assertPluginKind(kind: PluginKind, expected: readonly PluginKind[], pluginId: string): void {
  if (!expected.includes(kind)) {
    throw pluginError('permission_denied', `plugin ${pluginId} kind=${kind} is not allowed here (${expected.join('/')})`);
  }
}
