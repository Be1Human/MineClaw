/**
 * FEAT-CROSS-26-001-004-004 · production builtin index assembly (P3-1).
 * Loads the committed generated index (builtin-manifest.generated.json +
 * builtin-index.generated.ts static factory map) into a BuiltinPluginIndex —
 * the composition root never scans source at runtime. Combined with PluginHost
 * this is the I07 production discovery gate for the full first-party set.
 */
import { readFileSync } from 'node:fs';
import type { BuiltinPluginIndex, PluginFactory } from './discovery.js';
import { BUILTIN_PLUGIN_FACTORIES } from './builtin-index.generated.js';
import { pluginError } from '../plugin-sdk/errors.js';

export interface ProductionIndexInput {
  readonly manifestPath: string;
  readonly factories?: ReadonlyMap<string, PluginFactory>;
}

export function loadProductionBuiltinIndex(input: ProductionIndexInput): BuiltinPluginIndex {
  let parsed: { schema?: string; plugins?: Array<{ pluginId: string; entryKey: string; manifest: Record<string, unknown> }> };
  try {
    parsed = JSON.parse(readFileSync(input.manifestPath, 'utf8')) as typeof parsed;
  } catch (error) {
    throw pluginError('manifest_invalid', `builtin index unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.schema !== 'mineclaw.builtin-index/v1') {
    throw pluginError('manifest_invalid', `unexpected builtin index schema: ${String(parsed.schema)}`);
  }
  const factories = input.factories ?? BUILTIN_PLUGIN_FACTORIES;
  const byEntryKey = new Map<string, { entryKey: string; manifest: Record<string, unknown>; factory: PluginFactory }>();
  for (const plugin of parsed.plugins ?? []) {
    const factory = factories.get(plugin.entryKey);
    const manifestKind = (plugin.manifest as Record<string, unknown>).kind;
    if (!factory && manifestKind !== 'data') {
      throw pluginError('manifest_invalid', `entry ${plugin.entryKey} has no static factory in the generated index`);
    }
    byEntryKey.set(plugin.entryKey, {
      entryKey: plugin.entryKey,
      manifest: plugin.manifest,
      factory: factory as PluginFactory,
    });
  }
  return { byEntryKey };
}
