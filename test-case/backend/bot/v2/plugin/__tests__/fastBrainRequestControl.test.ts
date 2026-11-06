import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionContext, DecisionHandlerResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { FastBrainPendingRequests } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/pendingRequests.js';
const base:DecisionContext={requestId:'target',sessionId:'s',actor:'worker',dimension:'overworld',notBefore:0,
  deadlineAt:Date.now()+5000,signal:new AbortController().signal,isCurrent:()=>true};
function setup(context:DecisionContext=base){
  const pending=new FastBrainPendingRequests();
  let complete!:(r:DecisionHandlerResult)=>void;
  let aborts=0;
  const wrapped=pending.wrap({lifetime:'body',available:true,run:(_,c)=>new Promise(resolve=>{
    complete=resolve;c.signal.addEventListener('abort',()=>{aborts++;},{once:true});
  })});
  const submit=()=>wrapped.run({type:'call',skill:'equip',args:{}},context);
  const cancel=(override:Partial<DecisionContext>={})=>pending.cancelHandler().run(
    {type:'call',skill:'cancel',args:{request_id:'target'}},{...context,requestId:'control',...override});
  return {pending,submit,cancel,complete:(r:DecisionHandlerResult)=>complete(r),aborts:()=>aborts};
}
const stopped:DecisionHandlerResult={status:'cancelled',effectKnowledge:'confirmed',evidenceRefs:['inventory:1'],
  details:{stop:{state:'quiesced',operationId:'target',leaseRef:'l1',at:Date.now()},effects:['inventory:1']}};
test('cancel never signals another session/actor/world or a duplicate request',async()=>{
  const f=setup();const running=f.submit();await Promise.resolve();
  for(const guard of [{sessionId:'other'},{actor:'other'},{dimension:'nether'},{requestId:'target'}]){
    assert.equal((await f.cancel(guard)).status,'blocked');
  }
  assert.equal((await f.submit()).reason,'request_already_in_flight');
  assert.equal(f.aborts(),0);
  f.complete(stopped);await running;
  assert.equal((await f.cancel()).reason,'no_matching_live_request');
});
test('exact cancellation joins original result; without matching stop it stays unknown',async()=>{
  for(const actual of [stopped,{...stopped,details:{}},{...stopped,details:{stop:{...stopped.details!.stop as object,operationId:'wrong'}}}]){
    const f=setup();const running=f.submit();await Promise.resolve();
    const c=f.cancel();assert.equal(f.aborts(),1);
    f.complete(actual);const r=await c;await running;
    assert.equal(r.status,actual===stopped?'success':'partial');
    assert.equal(r.effectKnowledge,actual===stopped?'confirmed':'unknown');
  }
});
test('cancel before dispatch never invokes body; watchers bind to a single original promise',async()=>{
  const f=setup();const running=f.submit();
  const watched=f.pending.watch('target',{...base,requestId:'wait-1'});
  assert.ok(watched);assert.equal(watched(),undefined);
  assert.equal(f.pending.watch('target',{...base,requestId:'wait-1',sessionId:'other'}),null);
  const c=f.cancel();assert.equal((await c).reason,'cancelled_before_dispatch');await running;
  assert.equal(watched()?.status,'cancelled');
  assert.equal(f.aborts(),0);
});

test('host revocation or deadline expiry before the dispatch microtask never invokes the body', async () => {
  let current = true;
  const revoked = setup({ ...base, isCurrent: () => current });
  const first = revoked.submit();
  current = false;
  assert.equal((await first).status, 'cancelled');
  assert.equal(revoked.aborts(), 0);
  const expired = setup({ ...base, deadlineAt: Date.now() - 1 });
  assert.equal((await expired.submit()).status, 'timeout');
  assert.equal(expired.aborts(), 0);
});

test('cancel joins original drainage but cannot report success after the caller is revoked', async () => {
  const f = setup();
  const running = f.submit();
  await Promise.resolve();
  const abort = new AbortController();
  const cancelling = f.cancel({ signal: abort.signal });
  assert.equal(f.aborts(), 1);
  abort.abort();
  f.complete(stopped);
  const result = await cancelling;
  await running;
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'cancellation_context_revoked');
  assert.deepEqual(result.details?.stop, stopped.details?.stop);
  assert.equal(result.effectKnowledge, 'confirmed');
});

test('watchers reject aborted callers, return detached receipts and cannot follow a reused request ID', async () => {
  const f = setup();
  const running = f.submit();
  const caller = { ...base, requestId: 'observer' };
  const watch = f.pending.watch('target', caller)!;
  assert.ok(watch);
  assert.equal(f.pending.watch('target', { ...caller, signal: AbortSignal.abort() }), null);
  await Promise.resolve();
  f.complete(stopped);
  await running;
  const snapshot = watch()!;
  (snapshot.evidenceRefs as string[]).push('caller:edited');
  assert.deepEqual(watch()?.evidenceRefs, stopped.evidenceRefs);
  const next = f.submit();
  await Promise.resolve();
  const replacement = { ...stopped, status: 'error' as const, evidenceRefs: ['different:request'] };
  f.complete(replacement);
  await next;
  assert.deepEqual(watch()?.evidenceRefs, stopped.evidenceRefs);
});
