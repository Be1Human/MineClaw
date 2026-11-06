import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationLedger, operationArgsHash } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationLedger.js';
import type { OperationIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';
import type { OperationReceipt } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/operationReceipt.js';
import { readOriginalFastBrainReceipt } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/originalReceipt.js';

test('same request reads the original durable receipt; unknown, changed request, owner or scope never replay',()=>{
  const ledger=new OperationLedger(':memory:');
  try {
    const owner={kind:'goal' as const,sessionId:'s',taskId:'t',planRevision:3,epoch:2};
    const contribution={pluginId:'mineclaw.minecraft-system',pluginVersion:'1.0.0',contributionId:'mineclaw.minecraft-system.execution.fastbrain',contributionVersion:'1.0.0'};
    const snapshot={generationId:'g1',buildId:'b1',graphHash:'hash'};
    const args={target:{itemName:'iron_helmet',slot:'head'},source:'fastbrain',timeoutMs:1000};
    const command={ref:{id:'atomic:fastbrain_equip',contribution},snapshot,args};
    const ctx={owner,operationId:'r1',command,scope:{dimension:'overworld',targetRefs:[],bindings:[]},priority:1,expectedEffects:[]};
    const intent:OperationIntent={...ctx,deadlineAt:50,budget:{maxActions:1},preemption:'none'};
    const identity={owner,operationId:'r1',deadlineAt:50,operationEpoch:1,leaseRef:'original'};
    assert.equal(readOriginalFastBrainReceipt(ledger.get('r1'),ctx).kind,'absent');
    ledger.begin({identity,intent,startedAt:10,grantHash:'grant'});
    assert.equal(readOriginalFastBrainReceipt(ledger.get('r1'),ctx).kind,'unknown');
    const stop={...identity,state:'quiesced' as const,at:20};
    const rec:OperationReceipt={...identity,source:{commandId:command.ref.id,contribution,snapshot,argsHash:operationArgsHash(args),grantHash:'grant'},
      schema:'mineclaw.operation-receipt/v2',status:'succeeded',stop,startedAt:10,completedAt:21,noOp:false,effects:[],evidenceRefs:['slot:head']};
    ledger.acknowledgeStop('r1',stop);ledger.complete(rec);
    assert.deepEqual(readOriginalFastBrainReceipt(ledger.get('r1'),ctx),{kind:'receipt',receipt:rec});
    for(const other of [{owner:{...owner,epoch:3}},{scope:{...ctx.scope,dimension:'nether'}},
      {command:{...command,args:{...args,target:{itemName:'leather_helmet',slot:'head'}}}},
      {command:{...command,snapshot:{...snapshot,generationId:'g2'}}}]){
      assert.equal(readOriginalFastBrainReceipt(ledger.get('r1'),{...ctx,...other}).kind,'conflict');
    }
    const row=ledger.get('r1')!;
    assert.equal(readOriginalFastBrainReceipt({...row,receipt:{...rec,leaseRef:'wrong'}},ctx).kind,'unknown');
    assert.equal(readOriginalFastBrainReceipt({...row,receipt:{...rec,startedAt:9}},ctx).kind,'unknown');
    assert.equal(readOriginalFastBrainReceipt({...row,completedAt:22},ctx).kind,'unknown');
    assert.equal(readOriginalFastBrainReceipt({...row,effects:[{predicate:{id:'other',version:'1'},evidenceRefs:['other']}]},ctx).kind,'unknown');
    assert.equal(readOriginalFastBrainReceipt({...row,status:'ready_to_retry',receipt:null},ctx).kind,'unknown');
    assert.deepEqual(ledger.get('r1'),row);
  }finally{ledger.close();}
});

test('an original in-doubt receipt stays immutable when later stop evidence arrives', () => {
  const ledger = new OperationLedger(':memory:');
  try {
    const owner = { kind:'goal' as const, sessionId:'s', taskId:'t', planRevision:1, epoch:1 };
    const contribution = { pluginId:'mineclaw.minecraft-system', pluginVersion:'1.0.0',
      contributionId:'mineclaw.minecraft-system.execution.fastbrain', contributionVersion:'1.0.0' };
    const command = { ref:{id:'atomic:fastbrain_consume',contribution},
      snapshot:{generationId:'g1',buildId:'b1',graphHash:'hash'},args:{target:{itemName:'bread',maxCount:1}} };
    const expected = { operationId:'uncertain', owner, command,
      scope:{dimension:'overworld',targetRefs:[],bindings:[]},priority:1,expectedEffects:[] };
    const identity = { operationId:'uncertain', owner, operationEpoch:1, leaseRef:'original-lease', deadlineAt:50 };
    ledger.begin({ intent:{...expected,deadlineAt:50,budget:{maxActions:1},preemption:'none'},
      identity,startedAt:10,grantHash:'grant' });
    const receipt:OperationReceipt = { ...identity, schema:'mineclaw.operation-receipt/v2',
      source:{commandId:command.ref.id,contribution,snapshot:command.snapshot,argsHash:operationArgsHash(command.args),grantHash:'grant'},
      status:'in_doubt',stop:null,noOp:false,effects:[],evidenceRefs:['original:unknown'],startedAt:10,completedAt:51 };
    ledger.markInDoubt('uncertain','native_not_drained',51,receipt);
    ledger.acknowledgeStop('uncertain',{...identity,state:'quiesced',at:60});
    const before = ledger.get('uncertain')!;
    const read = readOriginalFastBrainReceipt(before,expected);
    assert.deepEqual(read,{kind:'receipt',receipt});
    if (read.kind === 'receipt') (read.receipt.evidenceRefs as string[]).push('caller:edited');
    assert.deepEqual(ledger.get('uncertain'),before);
    assert.equal(before.inDoubtReceipt?.stop,null);
    assert.equal(before.stop?.at,60);
  } finally { ledger.close(); }
});
