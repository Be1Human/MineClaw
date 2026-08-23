import type { MemoryKind, MemoryRecord } from './contracts.js';
import type { MemorySystem } from './retrieval/memorySystem.js';
import type { GoalAgentMemoryPort } from '../task/goalAgent/goalAgentRuntimeContracts.js';

const GOAL_AGENT_MEMORY_KINDS = new Set<MemoryKind>([
  'episode', 'spatial', 'event', 'task_experience', 'planning_policy',
]);

/** Progressive, task-scoped view that never exposes MainBrain identity/chat memory. */
export class GoalAgentMemoryKnowledgeAdapter implements GoalAgentMemoryPort {
  private readonly loaded = new Map<string, MemoryRecord>();

  constructor(private readonly memory: MemorySystem) {}

  search(input: { query: string; limit: number }) {
    const query = input.query.trim();
    if (!query) throw new Error('GoalAgent memory search query is required');
    const limit = Math.max(1, Math.min(12, Math.floor(input.limit)));
    const result = this.memory.deepRecall({ query, budget: 4_000, includeEvidence: true });
    const records = result.records
      .filter(record => GOAL_AGENT_MEMORY_KINDS.has(record.kind))
      .slice(0, limit)
      .map(record => structuredClone(record));
    for (const record of records) this.loaded.set(record.id, structuredClone(record));
    return {
      records,
      evidenceRefs: [...new Set(records.flatMap(record => record.evidenceRefs))],
      gaps: [...result.gaps],
      traceId: result.traceId,
    };
  }

  get(ref: string): MemoryRecord | null {
    const record = this.loaded.get(ref.trim());
    return record ? structuredClone(record) : null;
  }
}
