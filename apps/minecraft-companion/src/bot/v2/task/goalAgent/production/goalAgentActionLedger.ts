import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { openSqliteDatabase, type SqliteDatabase } from '../../../infra/sqliteDatabase.js';
import type { GoalAgentActionResult } from '../goalAgentState.js';

export type GoalAgentActionReplay =
  | {status:'new'}
  | {status:'completed';result:GoalAgentActionResult}
  | {status:'in_doubt';startedAt:string};

export interface GoalAgentActionLedgerPort {
  begin(input:{idempotencyKey:string;sessionId:string;epoch:number;proposal:unknown;startedAt:string}):GoalAgentActionReplay;
  complete(result:GoalAgentActionResult):void;
}

/** Durable idempotency boundary for physical GoalAgent actions. */
export class GoalAgentActionLedger implements GoalAgentActionLedgerPort {
  private readonly db:SqliteDatabase;

  constructor(filename:string) {
    if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
    this.db=openSqliteDatabase(filename);
    if(filename!==':memory:')this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_agent_actions (
        idempotency_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('started','completed')),
        proposal_json TEXT NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goal_agent_actions_session
        ON goal_agent_actions(session_id, started_at);
    `);
  }

  begin(input:{idempotencyKey:string;sessionId:string;epoch:number;proposal:unknown;startedAt:string}):GoalAgentActionReplay {
    return this.db.transaction(()=>{
      const existing=this.db.prepare(`
        SELECT status,result_json,started_at FROM goal_agent_actions WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as {status:'started'|'completed';result_json:string|null;started_at:string}|undefined;
      if(existing?.status==='completed'&&existing.result_json){
        const result=JSON.parse(existing.result_json) as GoalAgentActionResult;
        if(result.idempotencyKey!==input.idempotencyKey)throw new Error('GoalAgent action ledger result identity mismatch');
        return {status:'completed' as const,result:structuredClone(result)};
      }
      if(existing)return {status:'in_doubt' as const,startedAt:existing.started_at};
      this.db.prepare(`
        INSERT INTO goal_agent_actions (
          idempotency_key,session_id,epoch,status,proposal_json,result_json,started_at,completed_at
        ) VALUES (?, ?, ?, 'started', ?, NULL, ?, NULL)
      `).run(input.idempotencyKey,input.sessionId,input.epoch,JSON.stringify(input.proposal),input.startedAt);
      return {status:'new' as const};
    })();
  }

  complete(result:GoalAgentActionResult):void {
    const changed=this.db.prepare(`
      UPDATE goal_agent_actions SET status='completed',result_json=?,completed_at=?
      WHERE idempotency_key=? AND status='started'
    `).run(JSON.stringify(result),result.completedAt,result.idempotencyKey);
    if(changed.changes!==1){
      const existing=this.db.prepare(`
        SELECT result_json FROM goal_agent_actions WHERE idempotency_key=? AND status='completed'
      `).get(result.idempotencyKey) as {result_json:string|null}|undefined;
      const replay=existing?.result_json ? JSON.parse(existing.result_json) as GoalAgentActionResult : null;
      if(replay?.idempotencyKey!==result.idempotencyKey){
        throw new Error(`GoalAgent action ledger cannot complete ${result.idempotencyKey}`);
      }
    }
  }

  close():void { this.db.close(); }
}
