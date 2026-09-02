/**
 * Two DISTINCT machine contracts (kernel design §5.2):
 * - `PluginDependencyDeclaration`: structural hard dependency on a plugin or a
 *   contribution. Missing → the whole package cannot be constructed (`dependency_missing`).
 * - `ContributionRequirement`: runtime availability condition on an already
 *   registered contribution. Missing → that contribution is
 *   `availability=missing_dependency`; the package still registers.
 * The two must never be mixed; requiring something may not import/construct/call it.
 */
import { pluginError } from './errors.js';
import { isValidVersionRange } from './semver.js';

export interface PluginDependencyDeclaration {
  readonly pluginId: string;
  readonly range: string;
}

export interface ContributionDependencyDeclaration {
  readonly contributionId: string;
  readonly range: string;
}

export interface PluginDependenciesDeclaration {
  readonly plugins?: readonly PluginDependencyDeclaration[];
  readonly contributions?: readonly ContributionDependencyDeclaration[];
}

export interface ContributionRequirement {
  readonly contributionId: string;
  readonly range: string;
  readonly purpose: string;
}

export function isPluginDependencyDeclaration(value: unknown): value is PluginDependencyDeclaration {
  return isRecord(value)
    && typeof value.pluginId === 'string'
    && value.pluginId.trim().length > 0
    && typeof value.range === 'string';
}

export function isContributionDependencyDeclaration(value: unknown): value is ContributionDependencyDeclaration {
  return isRecord(value)
    && typeof value.contributionId === 'string'
    && value.contributionId.trim().length > 0
    && typeof value.range === 'string';
}

export function isContributionRequirement(value: unknown): value is ContributionRequirement {
  return isRecord(value)
    && typeof value.contributionId === 'string'
    && value.contributionId.trim().length > 0
    && typeof value.range === 'string'
    && typeof value.purpose === 'string'
    && value.purpose.trim().length > 0;
}

/**
 * Validate the structural dependency block of a manifest. Returns a frozen copy on
 * success; throws `manifest_invalid` on malformed declarations.
 */
export function parseDependencies(value: unknown): PluginDependenciesDeclaration {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) {
    throw pluginError('manifest_invalid', 'plugin manifest dependencies must be an object');
  }
  const plugins = value.plugins === undefined ? [] : asArray(value.plugins, 'manifest dependencies.plugins') as PluginDependencyDeclaration[];
  const contributions = value.contributions === undefined ? [] : asArray(value.contributions, 'manifest dependencies.contributions') as ContributionDependencyDeclaration[];
  for (const entry of plugins) {
    if (!isPluginDependencyDeclaration(entry)) {
      throw pluginError('manifest_invalid', `invalid plugin dependency declaration: ${JSON.stringify(entry)}`);
    }
    if (!isValidVersionRange(entry.range)) {
      throw pluginError('manifest_invalid', `invalid dependency range for plugin ${entry.pluginId}: ${entry.range}`);
    }
  }
  for (const entry of contributions) {
    if (!isContributionDependencyDeclaration(entry)) {
      throw pluginError('manifest_invalid', `invalid contribution dependency declaration: ${JSON.stringify(entry)}`);
    }
    if (!isValidVersionRange(entry.range)) {
      throw pluginError('manifest_invalid', `invalid dependency range for contribution ${entry.contributionId}: ${entry.range}`);
    }
  }
  const pluginIds = plugins.map((entry) => entry.pluginId);
  if (new Set(pluginIds).size !== pluginIds.length) {
    throw pluginError('manifest_invalid', 'duplicate plugin structural dependency');
  }
  const contributionIds = contributions.map((entry) => entry.contributionId);
  if (new Set(contributionIds).size !== contributionIds.length) {
    throw pluginError('manifest_invalid', 'duplicate contribution structural dependency');
  }
  return Object.freeze({
    ...(plugins.length > 0 ? { plugins: Object.freeze(plugins.map(freezePluginDependency)) } : {}),
    ...(contributions.length > 0 ? { contributions: Object.freeze(contributions.map(freezeContributionDependency)) } : {}),
  });
}

/** Validate a contribution-level runtime requirement list (missing → missing_dependency only). */
export function parseContributionRequirements(value: unknown): readonly ContributionRequirement[] {
  if (value === undefined) return [];
  const entries = asArray(value, 'contribution requirements') as ContributionRequirement[];
  for (const entry of entries) {
    if (!isContributionRequirement(entry)) {
      throw pluginError('manifest_invalid', `invalid contribution requirement: ${JSON.stringify(entry)}`);
    }
    if (!isValidVersionRange(entry.range)) {
      throw pluginError('manifest_invalid', `invalid requirement range for ${entry.contributionId}: ${entry.range}`);
    }
  }
  const ids = entries.map((entry) => entry.contributionId);
  if (new Set(ids).size !== ids.length) {
    throw pluginError('manifest_invalid', `duplicate contribution requirement id: ${[...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].join(',')}`);
  }
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

function freezePluginDependency(entry: PluginDependencyDeclaration): PluginDependencyDeclaration {
  return Object.freeze({ pluginId: entry.pluginId, range: entry.range });
}

function freezeContributionDependency(entry: ContributionDependencyDeclaration): ContributionDependencyDeclaration {
  return Object.freeze({ contributionId: entry.contributionId, range: entry.range });
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw pluginError('manifest_invalid', `${label} must be an array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
