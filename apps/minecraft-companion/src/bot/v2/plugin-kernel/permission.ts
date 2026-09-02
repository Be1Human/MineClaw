/**
 * Permission policy (kernel design §5.3 + P07).
 * Manifest declarations are compiled once at registration; every runtime access
 * is checked against the compiled set. A domain plugin may never obtain system
 * namespaces, undeclared atomic submission or arbitrary registry access.
 */
import { pluginError } from '../plugin-sdk/errors.js';
import { PERMISSION_ACTIONS, SYSTEM_PERMISSION_NAMESPACES } from '../plugin-sdk/permissions.js';
import type { PluginKind } from '../plugin-sdk/manifest.js';

export interface CompiledPermissionSet {
  readonly pluginId: string;
  readonly kind: PluginKind;
  readonly granted: ReadonlySet<string>;
  readonly readOnlyWorld: boolean;
  readonly bodySubmitAtomicIds: ReadonlySet<string>;
  readonly factReadIds: ReadonlySet<string>;
}

export interface PermissionAccessRequest {
  readonly permission: string;
  readonly pluginId?: string;
}

export function compilePermissions(pluginId: string, kind: PluginKind, declared: readonly string[]): CompiledPermissionSet {
  const granted = new Set(declared);
  const bodySubmitAtomicIds = new Set<string>();
  const factReadIds = new Set<string>();
  for (const permission of declared) {
    if (permission.startsWith(`${PERMISSION_ACTIONS.bodySubmit}:`)) {
      bodySubmitAtomicIds.add(permission.slice(PERMISSION_ACTIONS.bodySubmit.length + 1));
    }
    if (permission.startsWith(`${PERMISSION_ACTIONS.factRead}:`)) {
      factReadIds.add(permission.slice(PERMISSION_ACTIONS.factRead.length + 1));
    }
  }
  return Object.freeze({
    pluginId,
    kind,
    granted,
    readOnlyWorld: declared.includes('world.read:bounded-block-snapshot') || declared.includes('world.read:bounded-inventory'),
    bodySubmitAtomicIds,
    factReadIds,
  });
}

export function verifyPermissionAccess(compiled: CompiledPermissionSet, request: PermissionAccessRequest): void {
  if (request.pluginId !== undefined && request.pluginId !== compiled.pluginId) {
    throw pluginError('permission_denied', `plugin ${compiled.pluginId} may not act as ${request.pluginId}`);
  }
  if (compiled.kind === 'data') {
    throw pluginError('permission_denied', `data plugin ${compiled.pluginId} has no runtime permissions`);
  }
  if (request.permission.startsWith('system.')) {
    if (compiled.kind === 'system' && compiled.granted.has(request.permission)) return;
    throw pluginError('permission_denied', `system permission ${request.permission} is not available to ${compiled.pluginId}`);
  }
  if (!compiled.granted.has(request.permission)) {
    throw pluginError('permission_denied', `plugin ${compiled.pluginId} did not declare permission ${request.permission}`);
  }
}

/**
 * Static dependency gate for first-party domain plugins (kernel design §5.3).
 * The import list is produced by the build index generator from the plugin
 * source graph; the kernel rejects banned dependencies fail-closed.
 */
export interface StaticDependencyPolicy {
  /** Module import patterns (case-insensitive substring) banned for domain plugins. */
  readonly bannedImportPatterns: readonly RegExp[];
}

export const FIRST_PARTY_STATIC_POLICY: StaticDependencyPolicy = Object.freeze({
  bannedImportPatterns: [
    /\/bot\/adapter\//,
    /\/bot\/mineflayer\//,
    /gameadapter/i,
    /navigationadapter/i,
    /mineflayer/i,
    /gamebodydriver/i,
    /bodyexecutionruntime/i,
    /\/memory\//,
    /\/cognitive\/llm\//,
    /\/storage\//,
  ],
});

export function checkStaticDependencyPolicy(
  pluginId: string,
  entryKey: string,
  imports: readonly string[],
  policy: StaticDependencyPolicy,
): void {
  for (const imported of imports) {
    const normalized = imported.replace(/\\/g, '/');
    const banned = policy.bannedImportPatterns.find((pattern) => pattern.test(normalized));
    if (banned) {
      throw pluginError('permission_denied', `plugin ${pluginId} (${entryKey}) statically imports banned path ${imported} (${banned.source})`);
    }
  }
}
