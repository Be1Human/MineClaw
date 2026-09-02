/**
 * mineclaw.plugin/v1 manifest — the closed machine contract for plugin packages
 * (kernel design §5.2). Validation is fail-closed and returns a deep-frozen
 * manifest or throws a structured PluginContractError.
 */
import { parseManifestContribution, DATA_PLUGIN_CONTRIBUTION_KINDS, type ManifestContribution } from './contributions.js';
import { parseDependencies, type PluginDependenciesDeclaration } from './dependencies.js';
import { pluginError } from './errors.js';
import { PLUGIN_ID_PATTERN } from './identity.js';
import { parsePermissions } from './permissions.js';
import { apiVersionCompatible, isValidSemVer } from './semver.js';

export const PLUGIN_MANIFEST_SCHEMA = 'mineclaw.plugin/v1';

export type PluginKind = 'data' | 'domain' | 'system';

export const PLUGIN_KINDS: readonly PluginKind[] = ['data', 'domain', 'system'];

export interface PluginManifestV1 {
  readonly schema: typeof PLUGIN_MANIFEST_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly kind: PluginKind;
  readonly entry?: string;
  readonly dependencies: PluginDependenciesDeclaration;
  readonly permissions: readonly string[];
  readonly contributions: readonly ManifestContribution[];
  readonly integrity?: { readonly contentSha256: string };
}

export interface PluginManifestValidationInput {
  readonly hostApiVersion: string;
  readonly trustedSystemPlugins?: readonly string[];
}

export function validatePluginManifest(value: unknown, input: PluginManifestValidationInput): PluginManifestV1 {
  if (!isRecord(value)) throw pluginError('manifest_invalid', 'plugin manifest must be an object');
  if (value.schema !== PLUGIN_MANIFEST_SCHEMA) {
    throw pluginError('manifest_invalid', `unsupported manifest schema: ${String(value.schema)}`);
  }
  const id = requireId(value.id, 'plugin id');
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw pluginError('manifest_invalid', `plugin id must match ${PLUGIN_ID_PATTERN.source}: ${id}`);
  }
  const version = requireString(value.version, 'plugin version');
  if (!isValidSemVer(version)) throw pluginError('manifest_invalid', `plugin version must be valid SemVer: ${version}`);
  const apiVersion = requireString(value.apiVersion, 'plugin apiVersion');
  if (!apiVersionCompatible(input.hostApiVersion, apiVersion)) {
    throw pluginError('plugin_api_incompatible', `plugin apiVersion ${apiVersion} is incompatible with host ${input.hostApiVersion}`);
  }
  const kind = requireKind(value.kind);

  if (kind === 'data') {
    if (value.entry !== undefined) throw pluginError('manifest_invalid', 'data plugin must not declare a code entry');
  } else {
    requireString(value.entry, 'plugin entry (first-party domain/system only)');
  }

  const dependencies = parseDependencies(value.dependencies);
  const permissions = parsePermissions(value.permissions, kind);
  const trustedSystemPlugins = input.trustedSystemPlugins ?? [];
  if (kind === 'system' && !trustedSystemPlugins.includes(id)) {
    throw pluginError('permission_denied', `system plugin ${id} is not in the release trust list`);
  }

  if (!Array.isArray(value.contributions)) throw pluginError('manifest_invalid', 'manifest contributions must be an array');
  const contributions: ManifestContribution[] = [];
  const ids = new Set<string>();
  value.contributions.forEach((raw, index) => {
    const contribution = parseManifestContribution(raw, id, kind, index);
    if (ids.has(contribution.id)) throw pluginError('id_conflict', `duplicate contribution id: ${contribution.id}`);
    ids.add(contribution.id);
    contributions.push(contribution);
  });

  if (kind === 'data') {
    for (const contribution of contributions) {
      if (!DATA_PLUGIN_CONTRIBUTION_KINDS.includes(contribution.kind)) {
        throw pluginError('manifest_invalid', `data plugin may only carry knowledge/skill contributions, found ${contribution.kind}`);
      }
    }
  }

  const integrity = value.integrity;
  if (kind === 'data') {
    assertIntegrity(integrity, id, true);
  } else {
    assertIntegrity(integrity, id, false);
  }
  const parsedIntegrity = integrity === undefined
    ? undefined
    : Object.freeze({ contentSha256: (integrity as Record<string, unknown>).contentSha256 as string });

  return Object.freeze({
    schema: PLUGIN_MANIFEST_SCHEMA,
    id,
    version,
    apiVersion,
    kind,
    ...(value.entry !== undefined ? { entry: requireString(value.entry, 'plugin entry') } : {}),
    dependencies,
    permissions,
    contributions: Object.freeze(contributions),
    ...(parsedIntegrity !== undefined ? { integrity: parsedIntegrity } : {}),
  });
}

function assertIntegrity(integrity: unknown, pluginId: string, required: boolean): void {
  if (integrity === undefined) {
    if (required) throw pluginError('manifest_invalid', `data plugin ${pluginId} requires content integrity`);
    return;
  }
  if (!isRecord(integrity)) throw pluginError('manifest_invalid', `${pluginId} integrity must be an object`);
  const hash = integrity.contentSha256;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw pluginError('manifest_invalid', `${pluginId} integrity.contentSha256 must be a 64-char hex digest`);
  }
}

function requireKind(value: unknown): PluginKind {
  if (typeof value === 'string' && PLUGIN_KINDS.includes(value as PluginKind)) return value as PluginKind;
  throw pluginError('manifest_invalid', `unknown plugin kind: ${String(value)}; expected ${PLUGIN_KINDS.join('/')}`);
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw pluginError('manifest_invalid', `${label} is required`);
  return value.trim();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw pluginError('manifest_invalid', `${label} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
