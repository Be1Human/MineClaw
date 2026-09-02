/**
 * Deterministic dependency resolution (kernel design §5.5).
 * Structural `dependencies` participate in linking and construction; a missing
 * dependency, a cycle, a duplicate resolve or an ID conflict rejects the whole
 * package set. Order is stable regardless of enumeration order.
 */
import { pluginError } from '../plugin-sdk/errors.js';
import { versionInRange } from '../plugin-sdk/semver.js';
import type { DiscoveredPluginPackage } from './discovery.js';

export interface ResolvedPluginSet {
  readonly order: readonly DiscoveredPluginPackage[];
  readonly byId: ReadonlyMap<string, DiscoveredPluginPackage>;
}

export function resolvePluginDependencies(packages: readonly DiscoveredPluginPackage[]): ResolvedPluginSet {
  const byId = new Map<string, DiscoveredPluginPackage>();
  for (const pkg of packages) {
    const existing = byId.get(pkg.identity.pluginId);
    if (existing && existing.identity.pluginVersion !== pkg.identity.pluginVersion) {
      throw pluginError('id_conflict', `plugin id ${pkg.identity.pluginId} resolves to multiple versions: ${existing.identity.pluginVersion} vs ${pkg.identity.pluginVersion}`);
    }
    byId.set(pkg.identity.pluginId, pkg);
  }

  const order: DiscoveredPluginPackage[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (pkg: DiscoveredPluginPackage): void => {
    const id = pkg.identity.pluginId;
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw pluginError('dependency_cycle', `plugin dependency cycle detected at ${id}`);
    }
    state.set(id, 'visiting');
    for (const dependency of pkg.manifest.dependencies.plugins ?? []) {
      const target = byId.get(dependency.pluginId);
      if (!target) {
        throw pluginError('dependency_missing', `plugin ${id} requires missing plugin ${dependency.pluginId}`);
      }
      if (!versionInRange(target.identity.pluginVersion, dependency.range)) {
        throw pluginError('dependency_missing', `plugin ${id} requires ${dependency.pluginId}@${dependency.range}, found ${target.identity.pluginVersion}`);
      }
      visit(target);
    }
    state.set(id, 'done');
    order.push(pkg);
  };
  for (const pkg of [...packages].sort((a, b) => a.identity.pluginId.localeCompare(b.identity.pluginId))) {
    visit(pkg);
  }

  // Contribution-level structural dependencies must resolve to a contribution in the set.
  const contributionIds = new Set<string>();
  for (const pkg of packages) {
    for (const contribution of pkg.manifest.contributions) contributionIds.add(contribution.id);
  }
  for (const pkg of packages) {
    for (const dependency of pkg.manifest.dependencies.contributions ?? []) {
      if (!contributionIds.has(dependency.contributionId)) {
        throw pluginError('reference_unresolved', `plugin ${pkg.identity.pluginId} requires missing contribution ${dependency.contributionId}`);
      }
    }
  }

  return { order: Object.freeze(order), byId };
}
