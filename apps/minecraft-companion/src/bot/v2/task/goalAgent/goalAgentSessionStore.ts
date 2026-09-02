import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteDatabase, type SqliteDatabase } from '../../infra/sqliteDatabase.js';
import {
  assertGoalAgentStateV1,
  cloneGoalAgentState,
  isGoalAgentTerminalPhase,
  migrateGoalAgentStateV1,
  type GoalAgentStateV1,
} from './goalAgentState.js';
import {
  GOAL_AGENT_SESSION_EVENT_SCHEMA_V1,
  deriveGoalAgentMessages,
  latestGoalAgentCheckpoint,
  messageEventId,
  projectGoalAgentMessages,
  type GoalAgentCompactionCheckpointInput,
  type GoalAgentMessageAppendInput,
  type GoalAgentSessionEventInput,
  type GoalAgentSessionEventLogPort,
  type GoalAgentSessionEventV1,
} from './goalAgentSessionEventLog.js';

export interface GoalAgentCheckpointCommit {
  expectedRevision: number;
  expectedEpoch: number;
  state: GoalAgentStateV1;
  /** Messages committed atomically with this state CAS. */
  messages?: readonly import('../../cognitive/llm/types.js').LLMChatMessage[];
  compaction?: Omit<GoalAgentCompactionCheckpointInput,
    'sessionId' | 'node' | 'stateRevision' | 'epoch' | 'occurredAt'>;
}

export interface GoalAgentSessionStorePort {
  create(state: GoalAgentStateV1): void;
  commit(input: GoalAgentCheckpointCommit): GoalAgentStateV1;
  get(sessionId: string): GoalAgentStateV1 | null;
  getActive(sessionId: string): GoalAgentStateV1 | null;
  findByRequestId(requestId:string):GoalAgentStateV1|null;
  listActive(): GoalAgentStateV1[];
  hasTerminal(sessionId: string): boolean;
}

export class GoalAgentStateConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number | null,
    readonly expectedEpoch: number,
    readonly actualEpoch: number | null,
  ) {
    super(`GoalAgent state conflict for ${sessionId}: expected revision/epoch ${expectedRevision}/${expectedEpoch}, actual ${actualRevision ?? 'none'}/${actualEpoch ?? 'none'}`);
    this.name = 'GoalAgentStateConflictError';
  }
}

export class GoalAgentTerminalSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`terminal GoalAgent session cannot be revived: ${sessionId}`);
    this.name = 'GoalAgentTerminalSessionError';
  }
}

export class GoalAgentSessionStore implements GoalAgentSessionStorePort, GoalAgentSessionEventLogPort {
  private readonly db: SqliteDatabase;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = openSqliteDatabase(filename);
    if (filename !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_agent_sessions (
        session_id TEXT PRIMARY KEY,
        interaction_session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_agent_sessions_interaction
        ON goal_agent_sessions(interaction_session_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_goal_agent_sessions_request
        ON goal_agent_sessions(request_id);
      CREATE TABLE IF NOT EXISTS goal_agent_terminals (
        session_id TEXT PRIMARY KEY,
        interaction_session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        state_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_agent_terminals_request
        ON goal_agent_terminals(request_id);
      CREATE TABLE IF NOT EXISTS goal_agent_session_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL,
        node TEXT,
        state_revision INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_goal_agent_session_events_type
        ON goal_agent_session_events(session_id, type, seq);
    `);
  }

  create(state: GoalAgentStateV1): void {
    assertGoalAgentStateV1(state);
    if (state.revision !== 0 || state.epoch !== 1 || isGoalAgentTerminalPhase(state.phase)) {
      throw new Error('new GoalAgent session must start at revision 0, epoch 1 and a non-terminal phase');
    }
    this.db.transaction(() => {
      if (this.hasTerminal(state.sessionId)) throw new GoalAgentTerminalSessionError(state.sessionId);
      const existing = this.activeRow(state.sessionId);
      if (existing) {
        throw new GoalAgentStateConflictError(state.sessionId, -1, existing.revision, state.epoch, existing.epoch);
      }
      this.insertActive(state);
      this.insertSessionEvent({
        eventId: `${state.sessionId}:input`,
        sessionId: state.sessionId,
        occurredAt: state.createdAt,
        type: 'input.accepted',
        node: 'ingress',
        stateRevision: state.revision,
        epoch: state.epoch,
        payload: { request: structuredClone(state.request) },
      });
      this.appendMessageInternal({
        sessionId: state.sessionId,
        node: 'ingress',
        stateRevision: state.revision,
        epoch: state.epoch,
        occurredAt: state.createdAt,
        messageIndex: 0,
        message: {
          role: 'user',
          content: `[GoalAgent delegated request]\n${state.request.requestText}`,
        },
      });
      this.insertSessionEvent({
        eventId: `${state.sessionId}:node:${state.revision}:${state.epoch}`,
        sessionId: state.sessionId,
        occurredAt: state.createdAt,
        type: 'node.entered',
        node: state.activeNode,
        stateRevision: state.revision,
        epoch: state.epoch,
        payload: { from: null, to: state.activeNode, phase: state.phase },
      });
      this.appendStateCheckpoint(state);
    })();
  }

  commit(input: GoalAgentCheckpointCommit): GoalAgentStateV1 {
    const next = cloneGoalAgentState(input.state);
    if (next.revision !== input.expectedRevision + 1) {
      throw new Error('GoalAgent commit must advance revision by exactly one');
    }
    if (next.epoch !== input.expectedEpoch && next.epoch !== input.expectedEpoch + 1) {
      throw new Error('GoalAgent commit may preserve epoch or advance it by exactly one');
    }
    this.db.transaction(() => {
      if (this.hasTerminal(next.sessionId)) throw new GoalAgentTerminalSessionError(next.sessionId);
      const current = this.activeRow(next.sessionId);
      if (!current || current.revision !== input.expectedRevision || current.epoch !== input.expectedEpoch) {
        throw new GoalAgentStateConflictError(
          next.sessionId,
          input.expectedRevision,
          current?.revision ?? null,
          input.expectedEpoch,
          current?.epoch ?? null,
        );
      }
      if (current.interaction_session_id !== next.interactionSessionId || current.request_id !== next.requestId) {
        throw new Error('GoalAgent session identity is immutable');
      }
      const previous = parseState(current.state_json);
      if (previous.progress) {
        if (!next.progress) throw new Error('progress_checkpoint_cannot_be_removed');
        for (const key of ['rounds', 'totalNoProgressRounds', 'recoveryAttempts'] as const) {
          if (next.progress[key] < previous.progress[key]) throw new Error(`progress_budget_cannot_reset:${key}`);
        }
        if (previous.progress.sentFeedbackKinds.some(kind => !next.progress!.sentFeedbackKinds.includes(kind))) throw new Error('progress_feedback_dedupe_cannot_reset');
        if (previous.progress.seenFingerprints.some(value => !next.progress!.seenFingerprints.includes(value))) throw new Error('progress_evidence_history_cannot_reset');
        if (previous.progress.waitStartedAt !== null && next.progress.waitStartedAt !== previous.progress.waitStartedAt) throw new Error('wait_budget_cannot_reset');
      }
      if (previous.schema === 'mineclaw.goal-agent-state/v2' && next.schema !== previous.schema) throw new Error('goal_agent_schema_downgrade_forbidden');
      if (previous.rootGoal?.schema === 'mineclaw.goal/v2'
        && (next.rootGoal?.schema !== 'mineclaw.goal/v2' || next.rootGoal.contentHash !== previous.rootGoal.contentHash)) {
        throw new Error('composed_root_goal_is_immutable');
      }
      if (previous.rootGoal?.schema === 'mineclaw.goal/v1' && next.rootGoal?.schema === 'mineclaw.goal/v2') throw new Error('running_v1_goal_cannot_be_reinterpreted');
      const firstMessageIndex = this.messageCount(next.sessionId);
      for (const [offset, message] of (input.messages ?? []).entries()) {
        this.appendMessageInternal({
          sessionId: next.sessionId,
          node: next.cognition.activeNode ?? next.activeNode,
          stateRevision: next.revision,
          epoch: next.epoch,
          message,
          messageIndex: firstMessageIndex + offset,
          occurredAt: next.updatedAt,
        });
      }
      if (input.compaction) {
        this.recordCompactionInternal({
          ...input.compaction,
          sessionId: next.sessionId,
          node: next.cognition.activeNode ?? next.activeNode,
          stateRevision: next.revision,
          epoch: next.epoch,
          occurredAt: next.updatedAt,
        });
      }
      if (isGoalAgentTerminalPhase(next.phase)) {
        this.db.prepare('DELETE FROM goal_agent_sessions WHERE session_id = ?').run(next.sessionId);
        this.db.prepare(`
          INSERT INTO goal_agent_terminals (
            session_id, interaction_session_id, request_id, revision, epoch,
            outcome, state_json, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          next.sessionId,
          next.interactionSessionId,
          next.requestId,
          next.revision,
          next.epoch,
          next.terminal!.outcome,
          JSON.stringify(next),
          next.terminal!.completedAt,
        );
        this.appendDerivedEvents(previous, next);
        this.appendStateCheckpoint(next);
        return;
      }
      const changed = this.db.prepare(`
        UPDATE goal_agent_sessions SET
          revision = ?, epoch = ?, phase = ?, state_json = ?, updated_at = ?
        WHERE session_id = ? AND revision = ? AND epoch = ?
      `).run(
        next.revision,
        next.epoch,
        next.phase,
        JSON.stringify(next),
        next.updatedAt,
        next.sessionId,
        input.expectedRevision,
        input.expectedEpoch,
      );
      if (changed.changes !== 1) {
        throw new GoalAgentStateConflictError(next.sessionId, input.expectedRevision, null, input.expectedEpoch, null);
      }
      this.appendDerivedEvents(previous, next);
      this.appendStateCheckpoint(next);
    })();
    return cloneGoalAgentState(next);
  }

  appendSessionEvent(input: GoalAgentSessionEventInput): GoalAgentSessionEventV1 {
    return this.db.transaction(() => this.insertSessionEvent(input))();
  }

  appendMessage(input: GoalAgentMessageAppendInput): GoalAgentSessionEventV1 {
    return this.db.transaction(() => this.appendMessageInternal(input))();
  }

  syncMessages(input: Parameters<GoalAgentSessionEventLogPort['syncMessages']>[0]): number {
    return this.db.transaction(() => this.syncMessagesInternal(input))();
  }

  deriveMessages(sessionId: string) {
    return deriveGoalAgentMessages(this.listSessionEvents(sessionId));
  }

  projectMessages(sessionId: string) {
    return projectGoalAgentMessages(this.listSessionEvents(sessionId));
  }

  messageCount(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM goal_agent_session_events
      WHERE session_id = ? AND type = 'message.appended'
    `).get(sessionId) as { count: number };
    return row.count;
  }

  recordCompaction(input: GoalAgentCompactionCheckpointInput): GoalAgentSessionEventV1 | null {
    return this.db.transaction(() => this.recordCompactionInternal(input))();
  }

  private recordCompactionInternal(input: GoalAgentCompactionCheckpointInput): GoalAgentSessionEventV1 | null {
    const latest = this.db.prepare(`
      SELECT payload_json FROM goal_agent_session_events
      WHERE session_id = ? AND type = 'compaction.checkpoint'
      ORDER BY seq DESC LIMIT 1
    `).get(input.sessionId) as { payload_json: string } | undefined;
    if (latest) {
      const payload = JSON.parse(latest.payload_json) as Record<string, unknown>;
      if (payload.summary === input.summary && payload.throughMessageIndex === input.throughMessageIndex) return null;
    }
    if (!Number.isInteger(input.throughMessageIndex) || input.throughMessageIndex < 1
      || input.throughMessageIndex > this.messageCount(input.sessionId)) {
      throw new Error('GoalAgent compaction boundary must reference committed raw messages');
    }
    return this.insertSessionEvent({
      sessionId: input.sessionId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      type: 'compaction.checkpoint',
      node: input.node,
      stateRevision: input.stateRevision,
      epoch: input.epoch,
      payload: {
        summary: input.summary,
        omittedMessages: input.omittedMessages,
        throughMessageIndex: input.throughMessageIndex,
        rawMessagesRetained: this.messageCount(input.sessionId),
      },
    });
  }

  listSessionEvents(sessionId: string): GoalAgentSessionEventV1[] {
    const rows = this.db.prepare(`
      SELECT session_id, seq, event_id, occurred_at, type, node,
             state_revision, epoch, payload_json
      FROM goal_agent_session_events WHERE session_id = ? ORDER BY seq ASC
    `).all(sessionId) as GoalAgentSessionEventRow[];
    return rows.map(rowToSessionEvent);
  }

  replay(sessionId: string): GoalAgentStateV1 | null {
    const state = latestGoalAgentCheckpoint(this.listSessionEvents(sessionId));
    if (!state) return null;
    const migrated = migrateGoalAgentStateV1(state);
    assertGoalAgentStateV1(migrated);
    return migrated;
  }

  get(sessionId: string): GoalAgentStateV1 | null {
    return this.getActive(sessionId) ?? this.terminalState(sessionId);
  }

  getActive(sessionId: string): GoalAgentStateV1 | null {
    const row = this.activeRow(sessionId);
    return row ? parseState(row.state_json) : null;
  }

  findByRequestId(requestId:string):GoalAgentStateV1|null {
    const active=this.db.prepare(`SELECT state_json FROM goal_agent_sessions WHERE request_id=? ORDER BY updated_at DESC LIMIT 1`)
      .get(requestId) as {state_json:string}|undefined;
    if(active)return parseState(active.state_json);
    const terminal=this.db.prepare(`SELECT state_json FROM goal_agent_terminals WHERE request_id=? ORDER BY completed_at DESC LIMIT 1`)
      .get(requestId) as {state_json:string}|undefined;
    return terminal?parseState(terminal.state_json):null;
  }

  listActive(): GoalAgentStateV1[] {
    const rows = this.db.prepare(`
      SELECT state_json FROM goal_agent_sessions ORDER BY created_at, session_id
    `).all() as Array<{ state_json: string }>;
    return rows.map(row => parseState(row.state_json));
  }

  hasTerminal(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS present FROM goal_agent_terminals WHERE session_id = ?').get(sessionId));
  }

  close(): void {
    this.db.close();
  }

  private insertActive(state: GoalAgentStateV1): void {
    this.db.prepare(`
      INSERT INTO goal_agent_sessions (
        session_id, interaction_session_id, request_id, revision, epoch,
        phase, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.sessionId,
      state.interactionSessionId,
      state.requestId,
      state.revision,
      state.epoch,
      state.phase,
      JSON.stringify(state),
      state.createdAt,
      state.updatedAt,
    );
  }

  private appendMessageInternal(input: GoalAgentMessageAppendInput): GoalAgentSessionEventV1 {
    const messageIndex = input.messageIndex ?? this.messageCount(input.sessionId);
    const appended = this.insertSessionEvent({
      eventId: messageEventId(input.sessionId, messageIndex),
      sessionId: input.sessionId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      type: 'message.appended',
      node: input.node,
      stateRevision: input.stateRevision,
      epoch: input.epoch,
      payload: { message: structuredClone(input.message), messageIndex },
    });
    for (const call of input.message.tool_calls ?? []) {
      this.insertSessionEvent({
        eventId: `${input.sessionId}:tool-call:${call.id}`,
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        type: 'tool.called',
        node: input.node,
        stateRevision: input.stateRevision,
        epoch: input.epoch,
        payload: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        },
      });
    }
    if (input.message.role === 'tool' && input.message.tool_call_id) {
      this.insertSessionEvent({
        eventId: `${input.sessionId}:tool-result:${input.message.tool_call_id}`,
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        type: 'tool.result',
        node: input.node,
        stateRevision: input.stateRevision,
        epoch: input.epoch,
        payload: { callId: input.message.tool_call_id, content: input.message.content },
      });
    }
    return appended;
  }

  private syncMessagesInternal(input: Parameters<GoalAgentSessionEventLogPort['syncMessages']>[0]): number {
    let index = Math.max(0, input.afterMessageIndex);
    for (const message of input.messages.slice(index)) {
      this.appendMessageInternal({ ...input, message, messageIndex: index });
      index += 1;
    }
    return this.messageCount(input.sessionId);
  }

  private appendStateCheckpoint(state: GoalAgentStateV1): void {
    this.insertSessionEvent({
      eventId: `${state.sessionId}:state:${state.revision}:${state.epoch}`,
      sessionId: state.sessionId,
      occurredAt: state.updatedAt,
      type: 'state.checkpoint',
      node: state.cognition.activeNode ?? state.activeNode,
      stateRevision: state.revision,
      epoch: state.epoch,
      payload: { state: structuredClone(state) },
    });
  }

  private appendDerivedEvents(previous: GoalAgentStateV1, next: GoalAgentStateV1): void {
    if (previous.activeNode !== next.activeNode || previous.phase !== next.phase) {
      this.insertSessionEvent({
        eventId: `${next.sessionId}:node:${next.revision}:${next.epoch}`,
        sessionId: next.sessionId,
        occurredAt: next.updatedAt,
        type: 'node.entered',
        node: next.activeNode,
        stateRevision: next.revision,
        epoch: next.epoch,
        payload: { from: previous.activeNode, to: next.activeNode, phase: next.phase },
      });
    }
    if (next.world.observedAt && next.world.observedAt !== previous.world.observedAt) {
      this.insertSessionEvent({
        eventId: `${next.sessionId}:observation:${next.revision}:${next.epoch}`,
        sessionId: next.sessionId,
        occurredAt: next.world.observedAt,
        type: 'observation.recorded',
        node: next.cognition.activeNode ?? next.activeNode,
        stateRevision: next.revision,
        epoch: next.epoch,
        payload: { world: structuredClone(next.world.latest) },
      });
    }
    if (next.action.result
      && JSON.stringify(next.action.result) !== JSON.stringify(previous.action.result)) {
      this.insertSessionEvent({
        eventId: `${next.sessionId}:action:${next.action.result.idempotencyKey}`,
        sessionId: next.sessionId,
        occurredAt: next.action.result.completedAt,
        type: 'action.received',
        node: next.cognition.activeNode ?? next.activeNode,
        stateRevision: next.revision,
        epoch: next.epoch,
        payload: { result: structuredClone(next.action.result) },
      });
    }
    if (next.verdict && JSON.stringify(next.verdict) !== JSON.stringify(previous.verdict)) {
      this.insertSessionEvent({
        eventId: `${next.sessionId}:verdict:${next.revision}:${next.epoch}`,
        sessionId: next.sessionId,
        occurredAt: next.updatedAt,
        type: 'verification.recorded',
        node: next.cognition.activeNode ?? next.activeNode,
        stateRevision: next.revision,
        epoch: next.epoch,
        payload: { verdict: structuredClone(next.verdict) },
      });
    }
    if (next.terminal && !previous.terminal) {
      this.insertSessionEvent({
        eventId: `${next.sessionId}:terminal`,
        sessionId: next.sessionId,
        occurredAt: next.terminal.completedAt,
        type: 'terminal.recorded',
        node: 'terminal',
        stateRevision: next.revision,
        epoch: next.epoch,
        payload: { terminal: structuredClone(next.terminal) },
      });
    }
  }

  private insertSessionEvent(input: GoalAgentSessionEventInput): GoalAgentSessionEventV1 {
    const eventId = input.eventId?.trim() || randomUUID();
    const existing = this.db.prepare(`
      SELECT session_id, seq, event_id, occurred_at, type, node,
             state_revision, epoch, payload_json
      FROM goal_agent_session_events WHERE event_id = ?
    `).get(eventId) as GoalAgentSessionEventRow | undefined;
    if (existing) {
      const event = rowToSessionEvent(existing);
      if (event.sessionId !== input.sessionId || event.type !== input.type
        || JSON.stringify(event.payload) !== JSON.stringify(input.payload)) {
        throw new Error(`GoalAgent session eventId collision: ${eventId}`);
      }
      return event;
    }
    const seqRow = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq
      FROM goal_agent_session_events WHERE session_id = ?
    `).get(input.sessionId) as { seq: number };
    const event: GoalAgentSessionEventV1 = {
      schema: GOAL_AGENT_SESSION_EVENT_SCHEMA_V1,
      eventId,
      sessionId: input.sessionId,
      seq: seqRow.seq,
      occurredAt: input.occurredAt,
      type: input.type,
      node: input.node,
      stateRevision: input.stateRevision,
      epoch: input.epoch,
      payload: structuredClone(input.payload),
    };
    this.db.prepare(`
      INSERT INTO goal_agent_session_events (
        session_id, seq, event_id, occurred_at, type, node,
        state_revision, epoch, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId, event.seq, event.eventId, event.occurredAt, event.type,
      event.node ?? null, event.stateRevision, event.epoch, JSON.stringify(event.payload),
    );
    return structuredClone(event);
  }

  private activeRow(sessionId: string): ActiveRow | undefined {
    return this.db.prepare(`
      SELECT session_id, interaction_session_id, request_id, revision, epoch, state_json
      FROM goal_agent_sessions WHERE session_id = ?
    `).get(sessionId) as ActiveRow | undefined;
  }

  private terminalState(sessionId: string): GoalAgentStateV1 | null {
    const row = this.db.prepare('SELECT state_json FROM goal_agent_terminals WHERE session_id = ?')
      .get(sessionId) as { state_json: string } | undefined;
    return row ? parseState(row.state_json) : null;
  }
}

interface ActiveRow {
  session_id: string;
  interaction_session_id: string;
  request_id: string;
  revision: number;
  epoch: number;
  state_json: string;
}

interface GoalAgentSessionEventRow {
  session_id: string;
  seq: number;
  event_id: string;
  occurred_at: string;
  type: string;
  node: string | null;
  state_revision: number;
  epoch: number;
  payload_json: string;
}

function rowToSessionEvent(row: GoalAgentSessionEventRow): GoalAgentSessionEventV1 {
  return {
    schema: GOAL_AGENT_SESSION_EVENT_SCHEMA_V1,
    eventId: row.event_id,
    sessionId: row.session_id,
    seq: row.seq,
    occurredAt: row.occurred_at,
    type: row.type as GoalAgentSessionEventV1['type'],
    node: (row.node ?? undefined) as GoalAgentSessionEventV1['node'],
    stateRevision: row.state_revision,
    epoch: row.epoch,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function parseState(json: string): GoalAgentStateV1 {
  const state = migrateGoalAgentStateV1(JSON.parse(json) as GoalAgentStateV1);
  assertGoalAgentStateV1(state);
  return state;
}
