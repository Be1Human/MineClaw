import { isDeepStrictEqual as same } from 'node:util';
import type { ExecutionOwner, OperationCommand, OperationIntent } from '../../../task/contracts/bodyOperation.js';
import type { OperationReceipt } from '../../../task/contracts/operationReceipt.js';
import { operationArgsHash, type OperationLedgerRecord } from '../../../task/execution/operationLedger.js';

interface Expected {
  operationId:string;
  owner: Extract<ExecutionOwner,{kind:'goal'}>;
  command: OperationCommand;
  scope: OperationIntent['scope'];
  expectedEffects: OperationIntent['expectedEffects'];
  priority:number;
}
type Readback =
  | { kind:'absent' | 'conflict' | 'unknown' }
  | { kind:'receipt'; receipt:OperationReceipt };

/** Called only AFTER validating the live host binding. No write, grant, retry or new time origin. */
export function readOriginalFastBrainReceipt(record:OperationLedgerRecord | null, expected:Expected): Readback {
  if (!record) return {kind:'absent'};
  const {intent,identity}=record;
  if (!intent || !identity || !record.grantHash || !record.argsHash) return {kind:'unknown'};
  const {command,owner,operationId}=expected;
  if (operationId!==record.operationId || intent.operationId!==operationId || identity.operationId!==operationId
    || record.parentOperationId!==null || !same(identity.owner,owner) || !same(intent.owner,owner) || !same(intent.command,command)
    || !same(intent.scope,expected.scope) || intent.priority!==expected.priority || intent.preemption!=='none'
    || !same(intent.expectedEffects,expected.expectedEffects) || record.argsHash!==operationArgsHash(command.args)
    || !same(record.source,{...command.ref.contribution,...command.snapshot})) return {kind:'conflict'};
  const terminal=['succeeded','failed','cancelled'].includes(record.status);
  const receipt=terminal ? record.receipt : record.status==='in_doubt' ? record.inDoubtReceipt : null;
  if (!receipt || receipt.schema!=='mineclaw.operation-receipt/v2' || receipt.status!==record.status
    || receipt.operationId!==operationId || !same(receipt.owner,owner) || !identity.leaseRef || receipt.leaseRef!==identity.leaseRef
    || receipt.operationEpoch!==identity.operationEpoch || receipt.deadlineAt!==identity.deadlineAt
    || !same(receipt.source,{commandId:command.ref.id,contribution:command.ref.contribution,snapshot:command.snapshot,
      argsHash:record.argsHash,grantHash:record.grantHash})) return {kind:'unknown'};
  if (!Number.isFinite(receipt.startedAt) || !Number.isFinite(receipt.completedAt)
    || receipt.startedAt!==record.startedAt || receipt.completedAt<receipt.startedAt
    || terminal && (receipt.completedAt!==record.completedAt || !same(receipt.effects,record.effects))) return {kind:'unknown'};
  // An old in-doubt receipt is immutable even if the ledger later acquired a stop proof.
  if (terminal && (!receipt.stop || !same(record.stop,receipt.stop))) return {kind:'unknown'};
  if (receipt.stop && (receipt.stop.state!=='quiesced' || receipt.stop.operationId!==operationId
    || receipt.stop.leaseRef!==identity.leaseRef || !same(receipt.stop.owner,owner)
    || receipt.stop.operationEpoch!==identity.operationEpoch || receipt.stop.deadlineAt!==identity.deadlineAt)) return {kind:'unknown'};
  return {kind:'receipt',receipt:structuredClone(receipt)};
}
