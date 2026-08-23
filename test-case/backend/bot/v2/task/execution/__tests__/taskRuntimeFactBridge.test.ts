import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { EpisodeLedger } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { ExecutionFactIngestor } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/executionFactIngestor.js';
import { ExecutionFactLog } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionFactLog.js';
import { TaskRuntimeFactBridge } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/taskRuntimeFactBridge.js';

describe('TaskRuntimeFactBridge', () => {
  it('projects top-level goal task terminal events into a finalized episode', async () => {
    const bus = new EventBusV2();
    const facts = new ExecutionFactLog({ codeRevision: 'test', configRevision: 'test' });
    const task = {
      id: 'goal-1', kind: 'goal_exec', params: { goalText: 'make rails' }, feedbackRootId: 'root-1',
    };
    const bridge = new TaskRuntimeFactBridge(bus, { getById: id => id === task.id ? task : null }, facts, () => 100);

    bus.publish('task.started', 'info', { taskId: task.id, kind: task.kind });
    bus.publish('task.completed', 'info', { taskId: task.id, kind: task.kind });

    const ledger = new EpisodeLedger(':memory:');
    const summary = await new ExecutionFactIngestor(ledger).catchUp(facts);
    assert.equal(summary.accepted, 3);
    assert.equal(summary.finalized, 1);
    assert.equal(ledger.getEpisode(task.id)?.outcome, 'succeeded');
    bridge.close();
    ledger.close();
  });

  it('ignores leaf and emergency tasks and keeps failures structured', async () => {
    const bus = new EventBusV2();
    const facts = new ExecutionFactLog({ codeRevision: 'test', configRevision: 'test' });
    const tasks = new Map([
      ['mirror-1', { id: 'mirror-1', kind: 'craft', parentId: 'goal-1', params: {} }],
      ['goal-2', { id: 'goal-2', kind: 'goal_exec', params: { goalText: 'make rails' } }],
    ]);
    const bridge = new TaskRuntimeFactBridge(bus, { getById: id => tasks.get(id) ?? null }, facts);

    bus.publish('task.started', 'info', { taskId: 'mirror-1', kind: 'craft' });
    bus.publish('task.failed', 'recoverable', { taskId: 'mirror-1', detail: 'no_recipe' });
    bus.publish('task.started', 'info', { taskId: 'goal-2', kind: 'goal_exec' });
    bus.publish('task.failed', 'recoverable', { taskId: 'goal-2', detail: 'no_recipe' });

    assert.equal(facts.all().length, 3);
    const terminal = facts.all().at(-1)!;
    assert.equal(terminal.eventType, 'execution.session.terminal');
    assert.equal((terminal.payload.failure as { category: string }).category, 'resource');
    bridge.close();
  });

  it('marks forbidden recipe questions as learnable planning failures', () => {
    const bus = new EventBusV2();
    const facts = new ExecutionFactLog({ codeRevision: 'test', configRevision: 'test' });
    const task = { id: 'goal-3', kind: 'goal_exec', params: { goalText: 'make rails' } };
    const bridge = new TaskRuntimeFactBridge(bus, { getById: id => id === task.id ? task : null }, facts);
    bus.publish('task.started', 'info', { taskId: task.id, kind: task.kind });
    bus.publish('task.failed', 'recoverable', { taskId: task.id, code: 'need_owner', detail: 'goal need_owner' });
    const failure = facts.all().at(-1)!.payload.failure as {
      origin: string; code: string; category: string; ownerActionable: boolean; evidenceRefs: string[];
    };
    assert.equal(failure.origin, 'decision');
    assert.equal(failure.code, 'decision.need_owner');
    assert.equal(failure.category, 'precondition');
    assert.equal(failure.ownerActionable, false);
    assert.equal(failure.evidenceRefs.length, 1);
    bridge.close();
  });
});
