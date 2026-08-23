import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCapabilityResourcePackage } from '../../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityManifestLoader.js';
import { DomainKnowledgeRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/domainKnowledge.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';

const resources = loadCapabilityResourcePackage(join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../apps/minecraft-companion/capability-packages/agriculture',
));

test('FEAT-CROSS-19 · GoalAgent progressively loads Markdown Knowledge without execution permission', async () => {
  const domainKnowledge = new DomainKnowledgeRegistry(resources.knowledgeDocuments);
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'knowledge-test', tools: {}, domainKnowledge });
  assert.equal(runtime.names().includes('knowledge_search'), true);
  assert.equal(runtime.names().includes('knowledge_get'), true);
  const state = createGoalAgentState({
    sessionId: 'goal-knowledge',
    interactionSessionId: 'interaction-knowledge',
    request: {
      meta: { schemaVersion: 2, sessionId: 'i', messageId: 'm', correlationId: 'c', conversationId: 'v', sequence: 1, emittedAt: '2026-08-23T00:00:00Z', idempotencyKey: 'k' },
      origin: 'player_message', originalText: '小麦什么时候成熟', requestText: '小麦什么时候成熟', requestKind: 'task', constraints: [],
    },
  });
  const signal = new AbortController().signal;
  const searched = await runtime.execute({
    id: 'search', name: 'knowledge_search', arguments: { query: '小麦成熟' },
  }, state, signal);
  const result = (searched.content.knowledge as Array<{ ref: string; version: string }>)[0]!;
  assert.ok(result.ref.startsWith('knowledge:'));
  assert.equal(state.cognition.knowledgeRefs.includes(searched.evidenceRefs[0]!), true);

  const loaded = await runtime.execute({
    id: 'get', name: 'knowledge_get', arguments: { ref: result.ref, expectedVersion: result.version },
  }, state, signal);
  assert.equal(loaded.content.ok, true);
  assert.match(JSON.stringify(loaded.content), /age=7/);

  const actions = await runtime.execute({ id: 'actions', name: 'action_list', arguments: {} }, state, signal);
  assert.equal(actions.content.ok, false);
  assert.equal(actions.content.error, 'action_list_requires_execution_and_root_goal');
});
