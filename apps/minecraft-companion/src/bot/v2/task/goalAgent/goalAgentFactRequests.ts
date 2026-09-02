import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { validateClosedArguments } from '../../infra/closedJsonSchema.js';
import { tuning } from '../../infra/tuning.js';
import type { WorldFactRequest } from '../contracts/worldFact.js';

export function parseWorldFactRequests(raw: unknown): readonly WorldFactRequest[] {
  if (!Array.isArray(raw) || raw.length > tuning().goalEvidence.maxFactRequests) throw new Error('world_fact_request_limit_or_shape');
  const result = jsonSnapshot(raw);
  const identities = new Set<string>();
  for (const request of result) {
    validateClosedArguments(request, {
      type: 'object', required: ['providerId', 'version', 'params'], additionalProperties: false,
      properties: { providerId: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 }, params: { type: 'object' } },
    }, request);
    // One input per Provider in a snapshot avoids ambiguous same-identity facts.
    if (identities.has(request.providerId)) throw new Error('world_fact_duplicate_request');
    identities.add(request.providerId);
  }
  return result;
}
