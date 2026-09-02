import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import type { OperationCommand, OperationIntent } from '../contracts/bodyOperation.js';
import type { AuthorizedOperation, ExecutionAuthorityPort, ExecutionGrant } from './ports/bodyExecution.js';

interface GrantRecord {
  readonly intentJson: string;
  readonly isCurrent: () => boolean;
  readonly allowsChild: (command: OperationCommand) => boolean;
  revoked: boolean;
}

/** Trusted-code issuer. The body runtime only receives the read-only authority port. */
export class ExecutionAuthority implements ExecutionAuthorityPort {
  private readonly grants = new WeakMap<ExecutionGrant, GrantRecord>();

  issue(intent: OperationIntent, policy: {
    isCurrent(): boolean;
    allowsChild(command: OperationCommand): boolean;
  }): ExecutionGrant {
    if (typeof policy.isCurrent !== 'function' || typeof policy.allowsChild !== 'function') throw new Error('execution_policy_required');
    const intentJson = JSON.stringify(jsonSnapshot(intent));
    if (!policy.isCurrent()) throw new Error('execution_owner_not_current');
    const grant = Object.freeze(Object.create(null)) as ExecutionGrant;
    this.grants.set(grant, { intentJson, isCurrent: policy.isCurrent, allowsChild: policy.allowsChild, revoked: false });
    return grant;
  }

  revoke(grant: ExecutionGrant): void {
    const record = this.grants.get(grant);
    if (record) record.revoked = true;
  }

  allows(operation: AuthorizedOperation, command: OperationCommand): boolean {
    try {
      const record = this.grants.get(operation.grant);
      if (!record || record.revoked || !record.isCurrent()) return false;
      if (JSON.stringify(jsonSnapshot(operation.intent)) !== record.intentJson) return false;
      const commandJson = JSON.stringify(jsonSnapshot(command));
      return commandJson === JSON.stringify(jsonSnapshot(operation.intent.command)) || record.allowsChild(jsonSnapshot(command));
    } catch {
      // Policy errors, forged capabilities and non-JSON input fail closed.
      return false;
    }
  }
}
