/**
 * Machine permission declarations (kernel design §5.2/§5.3).
 * A plugin claiming a permission it never declared is rejected at runtime by the
 * permission policy (ownership lives in the kernel, FEAT-CROSS-26-001-004-002);
 * this module owns the closed contract and the manifest-side validation.
 */
import { pluginError } from './errors.js';

export const PERMISSION_ACTIONS = {
  worldRead: 'world.read',
  factRead: 'fact.read',
  bodySubmit: 'body.submit',
} as const;

export type PluginPermissionAction = (typeof PERMISSION_ACTIONS)[keyof typeof PERMISSION_ACTIONS];

/** System-only capability prefixes; ordinary first-party plugins may never declare them. */
export const SYSTEM_PERMISSION_NAMESPACES = ['system.adapter', 'system.storage', 'system.llm', 'system.atomic', 'system.event'] as const;

export type PluginPermissionDeclaration = string;

export function parsePermissions(value: unknown, kind: 'data' | 'domain' | 'system'): readonly string[] {
  if (value === undefined) {
    if (kind === 'data') return Object.freeze([]);
    throw pluginError('manifest_invalid', `plugin kind=${kind} must declare permissions`);
  }
  if (!Array.isArray(value)) throw pluginError('manifest_invalid', 'manifest permissions must be an array');
  if (kind === 'data' && value.length > 0) {
    throw pluginError('manifest_invalid', 'data plugin must not declare permissions');
  }
  const result: string[] = [];
  for (const permission of value) {
    if (typeof permission !== 'string' || !permission.trim()) {
      throw pluginError('permission_denied', `invalid permission declaration: ${JSON.stringify(permission)}`);
    }
    validatePermission(permission, kind);
    if (result.includes(permission)) throw pluginError('permission_denied', `duplicate permission: ${permission}`);
    result.push(permission);
  }
  return Object.freeze(result);
}

function validatePermission(permission: string, kind: 'data' | 'domain' | 'system'): void {
  if (permission.startsWith('system.')) {
    if (!(SYSTEM_PERMISSION_NAMESPACES as readonly string[]).includes(permission)) {
      throw pluginError('permission_denied', `unknown system permission: ${permission}`);
    }
    if (kind !== 'system') throw pluginError('permission_denied', `system permission ${permission} requires system plugin kind`);
    return;
  }
  const [action, resource] = splitPermission(permission);
  switch (action) {
    case PERMISSION_ACTIONS.worldRead:
      if (resource !== 'bounded-block-snapshot' && resource !== 'bounded-inventory') {
        throw pluginError('permission_denied', `unknown world.read resource: ${resource}`);
      }
      return;
    case PERMISSION_ACTIONS.factRead:
      if (!resource || !resource.includes('.')) throw pluginError('permission_denied', `invalid fact.read resource: ${resource}`);
      return;
    case PERMISSION_ACTIONS.bodySubmit:
      if (!resource || !resource.includes('.')) throw pluginError('permission_denied', `invalid body.submit resource: ${resource}`);
      return;
    default:
      throw pluginError('permission_denied', `unknown permission action: ${action}`);
  }
}

function splitPermission(permission: string): [string, string] {
  const index = permission.indexOf(':');
  if (index <= 0 || index === permission.length - 1) {
    throw pluginError('permission_denied', `malformed permission: ${permission}`);
  }
  return [permission.slice(0, index), permission.slice(index + 1)];
}
