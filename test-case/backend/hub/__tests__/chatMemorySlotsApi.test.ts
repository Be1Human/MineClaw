import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import { ChatMemoryService } from '../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';

test('official slot and model discovery control-plane APIs remain profile scoped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-slot-api-'));
  const dataDir = join(root, 'data');
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir });
  try {
    const profile = hub.profileStore.create({
      name: 'SlotApi',
      personality: { description: 'slot api fixture', style: 'calm' },
      server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
      llm: { apiKey: 'local-test-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'local-test-model' },
    });
    const prefill = new ChatMemoryService({ dbPath: join(dataDir, `chat-memory-${profile.id}.db`), profileId: profile.id, autoCapture: false });
    prefill.recordMessage({ id: 'candidate-source', sessionId: 's', role: 'owner', content: '雨天更适合我工作', timestamp: 1 });
    const candidate = prefill.addFact({ scope: 'user', kind: 'preference', text: '我更喜欢雨天工作', status: 'candidate', confidence: 0.5, importance: 0.6, sourceMessageIds: ['candidate-source'] });
    assert.ok(!('rejected' in candidate));
    prefill.close();

    await hub.listen();
    const address = hub.httpServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const base = `${origin}/api/bots/${profile.id}/chat-memory`;

    const empty = await fetch(`${base}/slots`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json().then((body: { total:number; filled:number; slots:unknown[] }) => ({ total:body.total, filled:body.filled, slots:body.slots.length })), { total:100, filled:0, slots:100 });

    const created = await fetch(`${base}/slots/preference.food.favorite/values`, {
      method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ value:'鱼' }),
    });
    assert.equal(created.status, 201);
    const value = await created.json() as { id:string; value:string };
    assert.equal(value.value, '鱼');

    const filled = await fetch(`${base}/slots?filledOnly=true`).then(response => response.json()) as { filled:number; slots:Array<{ definition:{ slotKey:string } }> };
    assert.equal(filled.filled, 1);
    assert.equal(filled.slots[0]?.definition.slotKey, 'preference.food.favorite');
    const sources = await fetch(`${base}/slot-values/${value.id}/sources`).then(response => response.json()) as { sources:Array<{ content:string }> };
    assert.match(sources.sources[0]?.content ?? '', /手工填写槽位/);

    if ('rejected' in candidate) return;
    const approved = await fetch(`${base}/facts/${candidate.id}/approve`, { method:'POST' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as { status:string }).status, 'active');
    assert.equal((await fetch(`${base}/slot-values/${value.id}`, { method:'DELETE' })).status, 200);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
