import { parseWorldFactRequests } from '../goalAgentFactRequests.js';
import { jsonSnapshot } from '../../../infra/jsonSnapshot.js';
import type { CapabilityWorldFactProvider } from '../../../capabilities/types.js';
import { assertSchemaSupported, validateClosedArguments } from '../../../infra/closedJsonSchema.js';
import { tuning } from '../../../infra/tuning.js';
import type { WorldStateView } from '../../../types.js';
import type { WorldFact, WorldFactRequest } from '../../contracts/worldFact.js';

export async function observeRequestedWorldFacts(
  world: WorldStateView, requests: readonly WorldFactRequest[], providers: readonly CapabilityWorldFactProvider[], signal: AbortSignal,
): Promise<readonly WorldFact[]> {
  const parsed = parseWorldFactRequests(requests);
  // Validate the entire batch before starting even a read-only scan.
  const prepared = parsed.map(request => {
    const matches = providers.filter(provider => provider.id === request.providerId && provider.version === request.version);
    if (matches.length !== 1 || !matches[0]!.inputSchema) throw new Error(`world_fact_provider_not_available:${request.providerId}@${request.version}`);
    const provider = matches[0]!;
    assertSchemaSupported(provider.inputSchema!);
    validateClosedArguments(request.params, provider.inputSchema!);
    return { request, provider };
  });
  const facts: WorldFact[] = [];
  for (const { request, provider } of prepared) {
    signal.throwIfAborted();
    const fact = await provider.observe({ world, params: request.params, signal });
    signal.throwIfAborted();
    const detached = jsonSnapshot(fact);
    if (detached.providerId !== request.providerId || detached.version !== request.version
      || typeof detached.complete !== 'boolean' || typeof detached.truncated !== 'boolean'
      || !Number.isFinite(detached.observedAt) || !detached.bounds || typeof detached.bounds !== 'object'
      || Array.isArray(detached.bounds) || !Array.isArray(detached.evidenceRefs)) throw new Error('world_fact_invalid_receipt');
    facts.push(detached);
    if (Buffer.byteLength(JSON.stringify(facts)) > tuning().goalEvidence.maxFactPayloadBytes) throw new Error('world_fact_payload_limit');
  }
  return facts;
}
