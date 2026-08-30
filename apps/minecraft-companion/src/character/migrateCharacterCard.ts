import type { CharacterCardV1 } from './types.js';
import { createCharacterTemplate } from './templates.js';

export interface LegacyCharacterProfile {
  name: string;
  ownerUsername?: string;
  personality?: { description?: string; style?: string; prompt?: string };
  characterCard?: CharacterCardV1;
}

export function resolveCharacterCard(profile: LegacyCharacterProfile): CharacterCardV1 {
  if (profile.characterCard?.schemaVersion === 1) {
    const card = structuredClone(profile.characterCard);
    card.performance.proactiveCapabilities ??= {};
    return card;
  }
  const card = createCharacterTemplate('real_world_friend', {
    characterName: profile.name,
    userName: profile.ownerUsername || '朋友',
  });
  const legacy = profile.personality?.prompt?.trim() || profile.personality?.description?.trim();
  if (legacy) card.character.personality.summary = legacy;
  if (profile.personality?.style?.trim()) card.character.personality.speechStyle = profile.personality.style.trim();
  card.performance.proactiveCapabilities = {};
  return card;
}
