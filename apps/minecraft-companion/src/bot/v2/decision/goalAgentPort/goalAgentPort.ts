import { randomUUID } from 'node:crypto';
import type { EventBusV2 } from '../../infra/eventBus.js';
import type { PerceptionPipeline } from '../../perception/pipeline.js';
import {
  type GoalContinuationV2,
  type GoalMessageReceiptV2,
  type GoalNotificationV1,
  type GoalReportV2,
  type GoalRequestV2,
  type GoalStatusSnapshotV2,
} from './contracts.js';
import { InteractionSessionManager } from './interactionSessionManager.js';
import { PerceptionAttentionGate } from './perceptionAttentionGate.js';
import {
  GoalProgressCommunicationGovernor,
  type GoalProgressCommunicationGovernorOptions,
} from './goalProgressCommunicationGovernor.js';
import {
  GoalSessionWatchdog,
  type GoalWatchdogSnapshotObservation,
  type GoalSessionWatchdogConfig,
  type GoalStatusInspector,
} from './goalSessionWatchdog.js';

export interface GoalAgentRequestSink {
  submit(request: GoalRequestV2): { accepted: boolean; reason?: string; details?: Record<string, unknown> };
}

export interface GoalAgentWatchdogOptions {
  inspector: GoalStatusInspector;
  config?: Partial<GoalSessionWatchdogConfig>;
  now?: () => number;
  tickIntervalMs?: number;
  autoStart?: boolean;
  isPersistentRequest?: (request: GoalRequestV2) => boolean;
  onSnapshot?: (observation: GoalWatchdogSnapshotObservation) => void | Promise<void>;
}

/** The sole bidirectional game boundary exposed to MainBrain. */
export class GoalAgentPort {
  private readonly unsubs: Array<() => void> = [];
  private readonly watchdog?: GoalSessionWatchdog;
  private readonly progressGovernor: GoalProgressCommunicationGovernor;
  private watchdogTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly bus: EventBusV2,
    private readonly perception: PerceptionPipeline,
    private readonly sink: GoalAgentRequestSink,
    private readonly attentionGate = new PerceptionAttentionGate(),
    private readonly sessions = new InteractionSessionManager(),
    private readonly watchdogOptions?: GoalAgentWatchdogOptions,
    progressOptions: GoalProgressCommunicationGovernorOptions = {},
  ) {
    this.progressGovernor = new GoalProgressCommunicationGovernor(progressOptions);
    if (watchdogOptions) {
      this.watchdog = new GoalSessionWatchdog({
        inspector: watchdogOptions.inspector,
        getSession: sessionId => this.sessions.getSession(sessionId),
        expireSession: sessionId => this.sessions.expireSession(sessionId),
        nextMessageMeta: (requestId, messageId, suffix) =>
          this.sessions.nextMessageMeta(requestId, messageId, suffix),
        onContinuation: continuation => this.publishWatchdogContinuation(continuation),
        isPersistentRequest: watchdogOptions.isPersistentRequest,
        onSnapshot: watchdogOptions.onSnapshot,
        now: watchdogOptions.now,
        config: watchdogOptions.config,
      });
      if (watchdogOptions.autoStart !== false) {
        this.watchdogTimer = setInterval(() => {
          void this.watchdog?.tick().catch(error => {
            this.bus.publish('goalagent.watchdog_error', 'recoverable', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, watchdogOptions.tickIntervalMs ?? 1_000);
        this.watchdogTimer.unref?.();
      }
    }
    this.unsubs.push(
      bus.on('under_attack', event => {
        const notification = this.attentionGate.onUnderAttack(
          event.payload as { prevHealth?: number; currHealth?: number; damage?: number },
          this.perception.getWorldState(),
          event.id,
        );
        if (notification) this.publishNotification(notification);
      }),
      bus.on('danger_cleared', event => {
        const notification = this.attentionGate.onDangerCleared(event.id);
        if (notification) this.publishNotification(notification);
      }),
      bus.on('goalagent.report', event => {
        const report = event.payload as Omit<GoalReportV2, 'meta'> & { meta?: GoalReportV2['meta'] };
        this.watchdog?.recordReport(report);
        let continuation: GoalContinuationV2 | null;
        if (report.status === 'running' && report.update) {
          const governed = this.progressGovernor.evaluate(report as GoalReportV2);
          this.bus.publish('goalagent.progress_report.governed', 'info', {
            requestId: report.requestId,
            update: report.update,
            level: governed.level,
            allowed: governed.allowed,
            reason: governed.reason,
          });
          continuation = governed.allowed
            ? this.sessions.handleStatusReport(report)
            : this.sessions.handleReport(report);
        } else {
          continuation = this.sessions.handleReport(report);
        }
        if (isTerminalReport(report.status)) this.progressGovernor.release(report.requestId);
        if (continuation) this.publishContinuation(continuation);
      }),
    );
  }

  beginPlayerTurn(turnId: string, originalText: string): void {
    this.sessions.beginPlayerTurn(turnId, originalText);
  }

  endPlayerTurn(turnId: string): void {
    this.sessions.endPlayerTurn(turnId);
  }

  beginContinuation(turnId: string, sessionId: string): void {
    this.sessions.beginContinuation(turnId, sessionId);
  }

  markReplied(sessionId: string): void {
    this.sessions.markReplied(sessionId);
  }

  cancelSessions(reason: string): void {
    for (const continuation of this.sessions.cancelAll(reason)) this.publishContinuation(continuation);
  }

  abandonSession(sessionId: string): void {
    this.sessions.abandonSession(sessionId);
  }

  isManagedRequest(requestId?: string): boolean {
    return this.sessions.hasRequest(requestId);
  }

  async runWatchdogCycle(): Promise<GoalContinuationV2[]> {
    return this.watchdog?.tick() ?? [];
  }

  async getGoalStatus(sessionId?: string): Promise<GoalContinuationV2 | null> {
    return this.watchdog?.queryStatus(sessionId) ?? null;
  }

  request(input: {
    requestText: string;
    requestKind: 'task' | 'query' | 'cancel';
    queryPurpose?: 'answer_player' | 'prepare_task';
    constraints?: string[];
  }): GoalMessageReceiptV2 {
    const request = this.sessions.createRequest(input);
    this.watchdog?.trackRequest(request);
    this.bus.publish('goalagent.request', 'info', request);
    try {
      const result = this.sink.submit(request);
      const receipt = this.receipt(request, result.accepted ? 'consumed' : 'failed', result.reason);
      this.watchdog?.recordReceipt(receipt);
      this.bus.publish('goalagent.receipt', result.accepted ? 'info' : 'recoverable', receipt);
      return receipt;
    } catch (error) {
      const receipt = this.receipt(request, 'failed', error instanceof Error ? error.message : String(error));
      this.watchdog?.recordReceipt(receipt);
      this.bus.publish('goalagent.receipt', 'recoverable', receipt);
      return receipt;
    }
  }

  /** MainBrain / WebUI 同步读取当前执行状态，不创建第二条游戏任务。 */
  getCurrentStatus(): GoalStatusSnapshotV2 | null {
    return this.watchdog?.inspectCurrentStatus() ?? null;
  }

  shutdown(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  private publishNotification(notification: GoalNotificationV1): void {
    this.bus.publish(
      'goalagent.notification',
      notification.urgency === 'critical' ? 'critical' : 'recoverable',
      notification,
    );
  }

  private publishContinuation(continuation: GoalContinuationV2): void {
    this.bus.publish('goalagent.continuation', 'info', continuation);
  }

  /** 自动状态探测与 GoalAgent 主动进展共用同一档位、去重、冷却和预算。 */
  private publishWatchdogContinuation(continuation: GoalContinuationV2): void {
    const report = continuation.triggeringReport;
    if (report.status === 'running' && report.update && continuation.reason !== 'user_requested') {
      const governed = this.progressGovernor.evaluate(report);
      this.bus.publish('goalagent.progress_report.governed', 'info', {
        source: 'watchdog',
        requestId: report.requestId,
        update: report.update,
        level: governed.level,
        allowed: governed.allowed,
        reason: governed.reason,
      });
      if (!governed.allowed) return;
    }
    this.publishContinuation(continuation);
  }

  private receipt(
    request: GoalRequestV2,
    outcome: GoalMessageReceiptV2['outcome'],
    reason?: string,
  ): GoalMessageReceiptV2 {
    const messageId = `goal-receipt-${randomUUID()}`;
    return {
      meta: this.sessions.nextMessageMeta(request.meta.messageId, messageId, 'receipt') ?? {
        ...request.meta, messageId, causationId:request.meta.messageId,
        sequence:request.meta.sequence+1, emittedAt:new Date().toISOString(),
        idempotencyKey:`${request.meta.correlationId}:receipt`,
      },
      sourceMessageId: request.meta.messageId,
      outcome,
      ...(reason ? { reason } : {}),
    };
  }
}

function isTerminalReport(status: GoalReportV2['status']): boolean {
  return ['answered', 'completed', 'failed', 'need_clarification', 'cancelled'].includes(status);
}
