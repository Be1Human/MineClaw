import { createHash } from 'node:crypto';
import type { ContextSignature } from './plannerContracts.js';

export interface PlannerContextInput {
  inventory?: Record<string, number> | Array<{ name:string; count:number }>;
  capabilities?: string[];
  nearbyFacilities?: string[];
  nearbyResources?: string[];
  biome?: string;
  timeOfDay?: number;
  dangerLevel?: number;
  position?: { x:number; y:number; z:number };
  worldRevision?: string;
}

export class ContextEncoder {
  encode(input: PlannerContextInput): ContextSignature {
    return Object.freeze({
      inventory: normalizeInventory(input.inventory),
      capabilities: uniqueSorted(input.capabilities ?? []),
      nearbyFacilities: uniqueSorted(input.nearbyFacilities ?? []),
      nearbyResources: uniqueSorted(input.nearbyResources ?? []),
      ...(input.biome ? { biome:input.biome } : {}),
      timeBucket: timeBucket(input.timeOfDay),
      dangerLevel: clamp(input.dangerLevel ?? 0, 0, 1),
      positionRegion: region(input.position),
      worldRevision: input.worldRevision ?? 'unknown',
    });
  }
}

/**
 * 实验配对使用的情境簇。运行 tick 不是世界版本，不能让同场景每毫秒都变成
 * 不可比较；其余会影响规划难度的字段保持确定性。
 */
export function comparableContextHash(context: ContextSignature): string {
  const revision = /^tick:\d+$/.test(context.worldRevision) ? 'runtime_world' : context.worldRevision;
  const comparable = {
    inventory:context.inventory,
    capabilities:[...context.capabilities].sort(),
    nearbyFacilities:[...context.nearbyFacilities].sort(),
    nearbyResources:[...context.nearbyResources].sort(),
    biome:context.biome??null,
    timeBucket:context.timeBucket,
    dangerBucket:Math.round(context.dangerLevel*10)/10,
    positionRegion:context.positionRegion,
    worldRevision:revision,
  };
  return createHash('sha256').update(stable(comparable)).digest('hex');
}

function normalizeInventory(value: PlannerContextInput['inventory']): Record<string,number> {
  const entries = Array.isArray(value) ? value.map(item => [item.name,item.count] as const) : Object.entries(value ?? {});
  return Object.fromEntries(entries.filter(([,count]) => count > 0).sort(([a],[b]) => a.localeCompare(b)));
}
function timeBucket(value?:number):ContextSignature['timeBucket'] { return value == null ? 'unknown' : value >= 0 && value < 12000 ? 'day' : 'night'; }
function region(position?:{x:number;y:number;z:number}):string { return position ? `${Math.floor(position.x/64)}:${Math.floor(position.z/64)}:${Math.floor(position.y/32)}` : 'unknown'; }
function uniqueSorted(values:string[]):string[]{return [...new Set(values)].sort();}
function clamp(value:number,min:number,max:number):number{return Math.min(max,Math.max(min,value));}
function stable(value:unknown):string{if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value as Record<string,unknown>).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;return JSON.stringify(value);}
