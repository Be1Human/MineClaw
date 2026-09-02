/**
 * Runtime availability semantics (kernel design §5.5).
 * Structural `dependencies` decide whether the package can be registered at all;
 * Contribution `requirements` only decide the contribution's availability inside
 * a registered generation. This helper is the single source for that second axis.
 */
import type { ContributionAvailability } from './errors.js';
import type { ContributionRequirement } from './dependencies.js';

export function evaluateContributionAvailability(
  requirements: readonly ContributionRequirement[] | undefined,
  resolvedContributions: ReadonlySet<string>,
): ContributionAvailability {
  if (!requirements || requirements.length === 0) return 'available';
  const missing = requirements.filter((requirement) => !resolvedContributions.has(requirement.contributionId));
  return missing.length > 0 ? 'missing_dependency' : 'available';
}
