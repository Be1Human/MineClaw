import type { GoalRequestV2, GoalStatusProbeV2, GoalStatusSnapshotV2 } from './contracts.js';
import {
  GoalCapabilityRouter,
  type GoalCapabilityDefinition,
  type GoalCapabilityMatch,
} from './goalCapabilityRouter.js';

export interface GoalCapabilityDispatchRecord {
  request: GoalRequestV2;
  definition: GoalCapabilityDefinition;
  details: Record<string, unknown>;
  runtimeRef?: string;
}

export interface GoalCapabilityHandler {
  submit(request: GoalRequestV2, match: GoalCapabilityMatch): GoalCapabilitySubmission;
  inspect?(probe: GoalStatusProbeV2, record: GoalCapabilityDispatchRecord): GoalStatusSnapshotV2;
}

export interface GoalCapabilitySubmission {
  accepted: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/** Routes capability definitions to registered runtime handlers without knowing business task kinds. */
export class GoalCapabilityDispatcher {
  private readonly handlers = new Map<string, GoalCapabilityHandler>();
  private readonly recordsByRequestId = new Map<string, GoalCapabilityDispatchRecord>();
  private readonly recordsBySessionId = new Map<string, GoalCapabilityDispatchRecord>();
  private readonly recordsByRuntimeRef = new Map<string, GoalCapabilityDispatchRecord>();

  constructor(private readonly router = new GoalCapabilityRouter()) {}

  register(handlerId: string, handler: GoalCapabilityHandler): void {
    if (!handlerId.trim()) throw new Error('goal capability handler id is required');
    if (this.handlers.has(handlerId)) throw new Error(`duplicate goal capability handler: ${handlerId}`);
    this.handlers.set(handlerId, handler);
  }

  submit(request: GoalRequestV2): GoalCapabilitySubmission {
    const match = this.router.resolve(request);
    const handler = this.handlers.get(match.definition.handler);
    if (!handler) {
      return { accepted: false, reason: `goal_capability_handler_missing:${match.definition.handler}` };
    }
    const result = handler.submit(request, match);
    if (!result.accepted) return result;
    const details: Record<string, unknown> = {
      ...(result.details ?? {}),
      capabilityId: match.definition.id,
    };
    const runtimeRef = typeof details.runtimeRef === 'string' ? details.runtimeRef : undefined;
    const record: GoalCapabilityDispatchRecord = {
      request,
      definition: match.definition,
      details,
      ...(runtimeRef ? { runtimeRef } : {}),
    };
    this.recordsByRequestId.set(request.meta.messageId, record);
    this.recordsBySessionId.set(request.meta.sessionId, record);
    if (runtimeRef) this.recordsByRuntimeRef.set(runtimeRef, record);
    return { ...result, details };
  }

  inspect(probe: GoalStatusProbeV2): GoalStatusSnapshotV2 {
    const record = this.recordsByRequestId.get(probe.requestId) ?? this.recordsBySessionId.get(probe.sessionId);
    if (!record) return unknownSnapshot(probe, 'goal_capability_dispatch_not_found');
    const handler = this.handlers.get(record.definition.handler);
    return handler?.inspect?.(probe, record) ?? unknownSnapshot(
      probe,
      `goal_capability_handler_not_observable:${record.definition.handler}`,
    );
  }

  findByRuntimeRef(runtimeRef: string): GoalCapabilityDispatchRecord | undefined {
    return this.recordsByRuntimeRef.get(runtimeRef);
  }

  findByRequestId(requestId: string): GoalCapabilityDispatchRecord | undefined {
    return this.recordsByRequestId.get(requestId);
  }
}

function unknownSnapshot(probe: GoalStatusProbeV2, stage: string): GoalStatusSnapshotV2 {
  return {
    sessionId: probe.sessionId,
    requestId: probe.requestId,
    state: 'unknown',
    stage,
    evidence: [],
    observedAt: new Date().toISOString(),
  };
}
