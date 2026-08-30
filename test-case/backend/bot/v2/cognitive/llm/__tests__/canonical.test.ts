import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LlmCanonicalizationError,
  canonicalizeChatMessages,
  canonicalizeChatTools,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/canonical.js';

describe('FEAT-CROSS-22 · canonical LLM compatibility entrance', () => {
  it('keeps text, tool calls and tool results protocol-neutral and ordered', () => {
    assert.deepEqual(canonicalizeChatMessages([
      { role: 'user', content: 'inspect the chest' },
      {
        role: 'assistant',
        content: 'I will inspect it.',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'inspect_chest', arguments: '{"position":{"x":1,"y":2,"z":3}}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"items":["stone"]}' },
    ]), [
      { role: 'user', content: [{ kind: 'text', text: 'inspect the chest' }] },
      {
        role: 'assistant',
        content: [
          { kind: 'text', text: 'I will inspect it.' },
          {
            kind: 'tool-call', id: 'call-1', name: 'inspect_chest',
            arguments: { position: { x: 1, y: 2, z: 3 } },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ kind: 'tool-result', callId: 'call-1', output: '{"items":["stone"]}' }],
      },
    ]);
  });

  it('flattens Chat tool schemas so codecs own their wire wrappers', () => {
    assert.deepEqual(canonicalizeChatTools([{
      type: 'function',
      function: {
        name: 'look',
        description: 'Look around',
        parameters: { type: 'object', properties: { radius: { type: 'number' } }, required: ['radius'] },
      },
    }]), [{
      name: 'look',
      description: 'Look around',
      parameters: { type: 'object', properties: { radius: { type: 'number' } }, required: ['radius'] },
    }]);
  });

  it('rejects malformed tool arguments before they can execute', () => {
    assert.throws(() => canonicalizeChatMessages([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'broken', type: 'function', function: { name: 'act', arguments: '{not-json' },
      }],
    }]), LlmCanonicalizationError);
  });
});
