import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import type { DomainKnowledgeDocument } from '../knowledge/domainKnowledge.js';
import { loadDomainKnowledge } from '../knowledge/domainKnowledge.js';
import type { GoalTargetCriterionTemplate, GoalTargetDefinition } from '../knowledge/goalTargetKnowledge.js';
import type { CapabilityManifestDefinition } from './types.js';
import type {
  ProactiveConfigFieldDefinition,
  ProactiveConfigSchema,
  ProactiveTickManifestEntry,
} from '../proactive/contracts.js';

export interface CapabilityResourcePackage {
  readonly packageDir: string;
  readonly manifest: CapabilityManifestDefinition;
  readonly knowledgeDocuments: readonly DomainKnowledgeDocument[];
}

export function loadCapabilityResourcePackage(packageDir: string): CapabilityResourcePackage {
  const root = fs.realpathSync(packageDir);
  const manifest = loadCapabilityManifest(root);
  const knowledgeDir = path.join(root, 'knowledge');
  const knowledgeDocuments = loadDomainKnowledge(knowledgeDir);
  const documentIds = new Set(knowledgeDocuments.map(document => document.id));
  for (const knowledgeId of manifest.knowledge) {
    if (!documentIds.has(knowledgeId)) {
      throw new Error(`capability manifest ${manifest.id} references unavailable Knowledge: ${knowledgeId}`);
    }
  }
  for (const documentId of documentIds) {
    if (!manifest.knowledge.includes(documentId)) {
      throw new Error(`capability manifest ${manifest.id} has unreferenced Knowledge: ${documentId}`);
    }
  }
  return Object.freeze({
    packageDir: root,
    manifest,
    knowledgeDocuments: Object.freeze([...knowledgeDocuments]),
  });
}

export function loadCapabilityManifest(packageDir: string): CapabilityManifestDefinition {
  const root = fs.realpathSync(packageDir);
  const file = path.join(root, 'capability.yaml');
  if (!fs.existsSync(file)) throw new Error(`capability manifest does not exist: ${file}`);
  const actual = fs.realpathSync(file);
  if (!isWithin(root, actual)) throw new Error(`capability manifest escapes package root: ${actual}`);
  const raw = parse(fs.readFileSync(actual, 'utf8')) as unknown;
  if (!isRecord(raw)) throw new Error(`invalid capability manifest: ${actual}`);
  if (raw.schema !== 'mineclaw/capability-manifest@1') throw new Error(`unsupported capability manifest schema: ${String(raw.schema)}`);
  const id = requiredText(raw.id, 'id');
  const version = positiveInteger(raw.version, 'version');
  const description = requiredText(raw.description, 'description');
  const goalTargets = objectArray(raw.goalTargets, 'goalTargets').map(parseGoalTarget);
  const skills = stringArray(raw.skills, 'skills');
  const knowledge = stringArray(raw.knowledge, 'knowledge').map(value => value.toLowerCase());
  const requires = parseRequires(raw.requires);
  const proactiveTicks = raw.proactiveTicks === undefined
    ? []
    : objectArray(raw.proactiveTicks, 'proactiveTicks').map(parseProactiveTick);
  if (goalTargets.length === 0) throw new Error(`capability manifest ${id} requires goalTargets`);
  if (skills.length === 0) throw new Error(`capability manifest ${id} requires Skill references`);
  if (knowledge.length === 0) throw new Error(`capability manifest ${id} requires Knowledge references`);
  rejectDuplicates(skills, 'Skill');
  rejectDuplicates(knowledge, 'Knowledge');
  rejectDuplicates(goalTargets.map(target => target.registryId), 'goal target');
  rejectDuplicates(proactiveTicks.map(tick => tick.id), 'proactive Tick');
  return Object.freeze({
    schema: 'mineclaw/capability-manifest@1',
    id,
    version,
    description,
    goalTargets: Object.freeze(goalTargets),
    skills: Object.freeze(skills),
    knowledge: Object.freeze(knowledge),
    requires,
    proactiveTicks: Object.freeze(proactiveTicks),
  });
}

function parseProactiveTick(value: Record<string, unknown>): ProactiveTickManifestEntry {
  const rate = requiredText(value.rate, 'proactiveTicks.rate').toLowerCase();
  if (!['fast', 'std', 'slow', 'idle'].includes(rate)) {
    throw new Error(`invalid proactive Tick rate: ${rate}`);
  }
  const decisionMode = requiredText(value.decisionMode, 'proactiveTicks.decisionMode').toLowerCase();
  if (decisionMode !== 'deterministic' && decisionMode !== 'deliberative') {
    throw new Error(`invalid proactive Tick decisionMode: ${decisionMode}`);
  }
  if (typeof value.defaultEnabled !== 'boolean') {
    throw new Error('capability manifest proactiveTicks.defaultEnabled must be boolean');
  }
  if (!Number.isFinite(value.priority)) {
    throw new Error('capability manifest proactiveTicks.priority must be a finite number');
  }
  const conflictGroups = value.conflictGroups === undefined
    ? []
    : stringArray(value.conflictGroups, 'proactiveTicks.conflictGroups');
  rejectDuplicates(conflictGroups, 'proactive Tick conflict group');
  const configSchema = value.configSchema === undefined
    ? Object.freeze({})
    : parseProactiveConfigSchema(value.configSchema);
  return Object.freeze({
    id: requiredText(value.id, 'proactiveTicks.id'),
    label: requiredText(value.label, 'proactiveTicks.label'),
    description: requiredText(value.description, 'proactiveTicks.description'),
    goalTarget: requiredText(value.goalTarget, 'proactiveTicks.goalTarget').toLowerCase(),
    defaultEnabled: value.defaultEnabled,
    rate: rate as ProactiveTickManifestEntry['rate'],
    priority: value.priority as number,
    decisionMode: decisionMode as ProactiveTickManifestEntry['decisionMode'],
    conflictGroups: Object.freeze(conflictGroups),
    configSchema,
  });
}

function parseProactiveConfigSchema(value: unknown): ProactiveConfigSchema {
  if (!isRecord(value)) throw new Error('capability manifest proactiveTicks.configSchema must be an object');
  const entries = Object.entries(value).map(([key, raw]) => {
    if (!key.trim() || !isRecord(raw)) {
      throw new Error('capability manifest proactive Tick config field must be an object');
    }
    const type = requiredText(raw.type, `proactiveTicks.configSchema.${key}.type`);
    if (type !== 'boolean' && type !== 'number' && type !== 'string') {
      throw new Error(`invalid proactive Tick config type: ${type}`);
    }
    const field: ProactiveConfigFieldDefinition = Object.freeze({
      type,
      label: requiredText(raw.label, `proactiveTicks.configSchema.${key}.label`),
      ...(raw.description === undefined
        ? {}
        : { description: requiredText(raw.description, `proactiveTicks.configSchema.${key}.description`) }),
      default: parseConfigDefault(type, raw.default, key),
      ...(raw.min === undefined ? {} : { min: finiteNumber(raw.min, `proactiveTicks.configSchema.${key}.min`) }),
      ...(raw.max === undefined ? {} : { max: finiteNumber(raw.max, `proactiveTicks.configSchema.${key}.max`) }),
      ...(raw.enum === undefined ? {} : { enum: Object.freeze(stringArray(raw.enum, `proactiveTicks.configSchema.${key}.enum`)) }),
    });
    validateConfigFieldBounds(key, field);
    return [key.trim(), field] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

function parseConfigDefault(
  type: ProactiveConfigFieldDefinition['type'],
  value: unknown,
  key: string,
): ProactiveConfigFieldDefinition['default'] {
  if (type === 'boolean' && typeof value === 'boolean') return value;
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (type === 'string' && typeof value === 'string') return value;
  throw new Error(`proactive Tick config default does not match type: ${key}`);
}

function validateConfigFieldBounds(key: string, field: ProactiveConfigFieldDefinition): void {
  if (field.type !== 'number' && (field.min !== undefined || field.max !== undefined)) {
    throw new Error(`proactive Tick config bounds require number type: ${key}`);
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    throw new Error(`proactive Tick config min exceeds max: ${key}`);
  }
  if (field.type === 'number') {
    const value = field.default as number;
    if (field.min !== undefined && value < field.min) throw new Error(`proactive Tick config default below min: ${key}`);
    if (field.max !== undefined && value > field.max) throw new Error(`proactive Tick config default above max: ${key}`);
  }
  if (field.enum) {
    if (field.type !== 'string') throw new Error(`proactive Tick config enum requires string type: ${key}`);
    if (!field.enum.includes(field.default as string)) throw new Error(`proactive Tick config default is outside enum: ${key}`);
  }
}

function parseGoalTarget(value: Record<string, unknown>): GoalTargetDefinition {
  const kind = requiredText(value.kind, 'goalTargets.kind');
  if (!['item', 'entity', 'location', 'structure', 'state'].includes(kind)) {
    throw new Error(`invalid capability goal target kind: ${kind}`);
  }
  const rawPolicy = value.successCriteriaPolicy === undefined
    ? undefined
    : requiredText(value.successCriteriaPolicy, 'goalTargets.successCriteriaPolicy');
  if (rawPolicy && rawPolicy !== 'fallback' && rawPolicy !== 'authoritative') {
    throw new Error(`invalid capability successCriteriaPolicy: ${rawPolicy}`);
  }
  const successCriteriaPolicy = rawPolicy as GoalTargetDefinition['successCriteriaPolicy'];
  const successCriteria = value.successCriteria === undefined
    ? undefined
    : objectArray(value.successCriteria, 'goalTargets.successCriteria').map(parseCriterion);
  return Object.freeze({
    kind: kind as GoalTargetDefinition['kind'],
    registryId: requiredText(value.registryId, 'goalTargets.registryId').toLowerCase(),
    aliases: Object.freeze(stringArray(value.aliases, 'goalTargets.aliases')),
    taskFamilies: Object.freeze(stringArray(value.taskFamilies, 'goalTargets.taskFamilies')),
    ...(successCriteriaPolicy ? { successCriteriaPolicy } : {}),
    ...(successCriteria ? { successCriteria: Object.freeze(successCriteria) } : {}),
  });
}

function parseCriterion(value: Record<string, unknown>): GoalTargetCriterionTemplate {
  const type = requiredText(value.type, 'successCriteria.type');
  if (type === 'predicate') return { type, predicate: requiredText(value.predicate, 'successCriteria.predicate') };
  if (type === 'entity_dead') return { type, entityName: requiredText(value.entityName, 'successCriteria.entityName') };
  if (type === 'reached') {
    if (value.relativeTo !== 'owner') throw new Error('reached criterion relativeTo must be owner');
    return { type, relativeTo: 'owner', radius: positiveNumber(value.radius, 'successCriteria.radius') };
  }
  if (type === 'inventory') {
    const count = value.count === '$quantity' ? '$quantity' : positiveInteger(value.count, 'successCriteria.count');
    return { type, item: requiredText(value.item, 'successCriteria.item'), count };
  }
  throw new Error(`unsupported capability goal criterion: ${type}`);
}

function parseRequires(value: unknown): CapabilityManifestDefinition['requires'] {
  if (!isRecord(value)) throw new Error('capability manifest requires must be an object');
  const atomics = stringArray(value.atomics, 'requires.atomics');
  if (atomics.length === 0) throw new Error('capability manifest requires.atomics must not be empty');
  const behaviors = value.behaviors === undefined ? undefined : stringArray(value.behaviors, 'requires.behaviors');
  const strategies = value.strategies === undefined ? undefined : stringArray(value.strategies, 'requires.strategies');
  rejectDuplicates(atomics, 'Atomic');
  if (behaviors) rejectDuplicates(behaviors, 'Behavior');
  if (strategies) rejectDuplicates(strategies, 'Strategy');
  return Object.freeze({
    atomics: Object.freeze(atomics),
    ...(behaviors ? { behaviors: Object.freeze(behaviors) } : {}),
    ...(strategies ? { strategies: Object.freeze(strategies) } : {}),
  });
}

function objectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`capability manifest ${field} must be an object array`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) {
    throw new Error(`capability manifest ${field} must be a string array`);
  }
  return value.map(item => (item as string).trim());
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`capability manifest ${field} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`capability manifest ${field} must be a positive integer`);
  return value as number;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`capability manifest ${field} must be positive`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`capability manifest ${field} must be finite`);
  return value;
}

function rejectDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate capability manifest ${label} reference`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
