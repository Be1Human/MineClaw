import type { CharacterCardV1, CharacterCardValidationError } from './types.js';

const LIMITS = {
  short: 120,
  medium: 800,
  long: 4000,
  listItems: 24,
  worldBookEntries: 80,
  exampleDialogs: 20,
} as const;

function stringField(
  errors: CharacterCardValidationError[], path: string, value: unknown, max: number, required = false,
): void {
  if (typeof value !== 'string') {
    if (required) errors.push({ path, code: 'required', message: '必填文本不能为空' });
    return;
  }
  if (required && !value.trim()) errors.push({ path, code: 'required', message: '必填文本不能为空' });
  if (value.length > max) errors.push({ path, code: 'too_long', message: `最多 ${max} 个字符` });
}

function stringList(errors: CharacterCardValidationError[], path: string, value: unknown): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    errors.push({ path, code: 'invalid', message: '必须是文本数组' });
    return;
  }
  if (value.length > LIMITS.listItems) errors.push({ path, code: 'too_many', message: `最多 ${LIMITS.listItems} 项` });
  value.forEach((item, index) => stringField(errors, `${path}.${index}`, item, LIMITS.short));
}

export function validateCharacterCard(value: unknown): CharacterCardValidationError[] {
  const errors: CharacterCardValidationError[] = [];
  if (!value || typeof value !== 'object') return [{ path: '', code: 'invalid', message: '角色卡必须是对象' }];
  const card = value as CharacterCardV1;
  if (card.schemaVersion !== 1) {
    errors.push({ path: 'schemaVersion', code: 'unsupported_version', message: '仅支持 CharacterCard schemaVersion=1' });
    return errors;
  }

  stringField(errors, 'character.identity.name', card.character?.identity?.name, LIMITS.short, true);
  stringField(errors, 'character.identity.selfConcept', card.character?.identity?.selfConcept, LIMITS.medium, true);
  stringField(errors, 'character.identity.background', card.character?.identity?.background, LIMITS.long);
  stringField(errors, 'character.identity.appearance', card.character?.identity?.appearance, LIMITS.medium);
  stringField(errors, 'character.personality.summary', card.character?.personality?.summary, LIMITS.medium, true);
  stringField(errors, 'character.personality.speechStyle', card.character?.personality?.speechStyle, LIMITS.medium, true);
  for (const key of ['traits', 'values', 'likes', 'dislikes', 'boundaries'] as const) {
    stringList(errors, `character.personality.${key}`, card.character?.personality?.[key]);
  }

  stringField(errors, 'relationship.type', card.relationship?.type, LIMITS.short, true);
  stringField(errors, 'relationship.history', card.relationship?.history, LIMITS.long);
  stringField(errors, 'relationship.interactionStyle', card.relationship?.interactionStyle, LIMITS.medium, true);
  stringField(errors, 'relationship.userPersona.name', card.relationship?.userPersona?.name, LIMITS.short, true);
  stringField(errors, 'relationship.userPersona.background', card.relationship?.userPersona?.background, LIMITS.long);

  stringField(errors, 'world.worldview', card.world?.worldview, LIMITS.long, true);
  stringField(errors, 'world.currentScene', card.world?.currentScene, LIMITS.long);
  stringField(errors, 'world.greeting', card.world?.greeting, LIMITS.medium);
  if (!Array.isArray(card.world?.worldBook)) {
    errors.push({ path: 'world.worldBook', code: 'invalid', message: '世界书必须是数组' });
  } else {
    if (card.world.worldBook.length > LIMITS.worldBookEntries) {
      errors.push({ path: 'world.worldBook', code: 'too_many', message: `最多 ${LIMITS.worldBookEntries} 条` });
    }
    const ids = new Set<string>();
    card.world.worldBook.forEach((entry, index) => {
      const base = `world.worldBook.${index}`;
      stringField(errors, `${base}.id`, entry?.id, LIMITS.short, true);
      stringField(errors, `${base}.title`, entry?.title, LIMITS.short, true);
      stringField(errors, `${base}.content`, entry?.content, LIMITS.long, true);
      stringList(errors, `${base}.keywords`, entry?.keywords);
      if (entry?.id && ids.has(entry.id)) errors.push({ path: `${base}.id`, code: 'invalid', message: '世界书 ID 不可重复' });
      if (entry?.id) ids.add(entry.id);
      if (!Number.isFinite(entry?.priority)) errors.push({ path: `${base}.priority`, code: 'invalid', message: '优先级必须是数字' });
    });
  }

  stringField(errors, 'performance.responseStyle', card.performance?.responseStyle, LIMITS.medium, true);
  if (!['low', 'medium', 'high'].includes(card.performance?.initiative)) {
    errors.push({ path: 'performance.initiative', code: 'invalid', message: '主动程度无效' });
  }
  if (!['none', 'light', 'rich'].includes(card.performance?.narration)) {
    errors.push({ path: 'performance.narration', code: 'invalid', message: '叙事强度无效' });
  }
  if (card.performance?.progressReportLevel !== undefined
    && !['quiet', 'balanced', 'talkative'].includes(card.performance.progressReportLevel)) {
    errors.push({ path: 'performance.progressReportLevel', code: 'invalid', message: '任务进展汇报档位无效' });
  }
  if (!Array.isArray(card.performance?.exampleDialogs)) {
    errors.push({ path: 'performance.exampleDialogs', code: 'invalid', message: '示例对白必须是数组' });
  } else {
    if (card.performance.exampleDialogs.length > LIMITS.exampleDialogs) {
      errors.push({ path: 'performance.exampleDialogs', code: 'too_many', message: `最多 ${LIMITS.exampleDialogs} 组` });
    }
    card.performance.exampleDialogs.forEach((dialog, index) => {
      stringField(errors, `performance.exampleDialogs.${index}.user`, dialog?.user, LIMITS.medium, true);
      stringField(errors, `performance.exampleDialogs.${index}.character`, dialog?.character, LIMITS.medium, true);
    });
  }
  for (const name of ['chat', 'memory', 'minecraft'] as const) {
    if (typeof card.performance?.capabilities?.[name] !== 'boolean') {
      errors.push({ path: `performance.capabilities.${name}`, code: 'invalid', message: '能力开关必须是布尔值' });
    }
  }
  return errors;
}
