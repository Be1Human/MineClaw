/**
 * Immutable source identity values (kernel design §5.6). These three are the only
 * identity shapes that travel with a Goal; they must never be rebuilt from the
 * latest Registry at execution time.
 */

export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

export interface PluginIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export interface ContributionRef {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly contributionId: string;
  readonly contributionVersion: string;
}

export interface RegistrySnapshotRef {
  readonly generationId: string;
  readonly buildId: string;
  readonly graphHash: string;
}

/** Minimal goal lease handed to plugin factories; Host manages generation/epoch identity. */
export interface PluginGoalLease {
  readonly goalId: string;
  readonly sessionId: string;
  readonly snapshot: RegistrySnapshotRef;
  readonly ownerEpoch: number;
  readonly operationEpoch: number;
  readonly aborted: boolean;
}

export function pluginIdentityOf(pluginId: string, pluginVersion: string): PluginIdentity {
  return Object.freeze({ pluginId, pluginVersion });
}

export function contributionRefOf(
  pluginId: string,
  pluginVersion: string,
  contributionId: string,
  contributionVersion: string,
): ContributionRef {
  return Object.freeze({ pluginId, pluginVersion, contributionId, contributionVersion });
}

export function refsEqual(left: ContributionRef, right: ContributionRef): boolean {
  return left.pluginId === right.pluginId
    && left.pluginVersion === right.pluginVersion
    && left.contributionId === right.contributionId
    && left.contributionVersion === right.contributionVersion;
}
