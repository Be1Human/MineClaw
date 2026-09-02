import type { IBehavior } from './types.js';

/** Loading fails closed on mixed/placeholder definitions, before any operation is admitted. */
export function assertBehaviorDefinition(value: IBehavior): void {
  const candidate = value as unknown as Record<string, unknown>;
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim() || 'plan' in candidate) {
    throw new Error('invalid_behavior_definition');
  }
  if (candidate.kind === 'sequence' && typeof candidate.compile === 'function' && !('run' in candidate)) return;
  if (candidate.kind === 'adaptive' && typeof candidate.run === 'function' && !('compile' in candidate)) return;
  throw new Error(`invalid_behavior_definition:${candidate.id}`);
}
