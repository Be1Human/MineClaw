import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import type { ExecutionFactSource, ExecutionFactSourcePage } from './executionFactIngestor.js';

/** Read-only adapter over the Coordinator's append-only JSONL commit log. */
export class JsonlExecutionFactSource implements ExecutionFactSource {
  constructor(private readonly filePath:string) {}

  async readAfter(cursor:string|null,limit:number):Promise<ExecutionFactSourcePage>{
    const offset=parseCursor(cursor),safeLimit=Math.max(1,Math.min(1000,Math.floor(limit)));
    if(!existsSync(this.filePath))return{facts:[],nextCursor:String(offset)};
    const lines=readFileSync(this.filePath,'utf8').split(/\r?\n/).filter(Boolean);
    const raw=lines.slice(offset,offset+safeLimit),facts:unknown[]=[];
    for(const line of raw){try{facts.push(JSON.parse(line) as unknown);}catch{facts.push({schema:'invalid-jsonl',raw:line});}}
    return{facts,nextCursor:String(offset+raw.length)};
  }

  subscribeWakeup(handler:()=>void):()=>void{
    let watcher:FSWatcher|null=null;
    try{watcher=watch(this.filePath,()=>handler());}catch{return()=>undefined;}
    return()=>watcher?.close();
  }
}
function parseCursor(cursor:string|null):number{if(cursor==null)return 0;const value=Number(cursor);if(!Number.isInteger(value)||value<0)throw new Error(`invalid execution fact cursor: ${cursor}`);return value;}
