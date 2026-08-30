export interface CharacterIdentity {
  name: string;
  species?: string;
  age?: string;
  occupation?: string;
  appearance?: string;
  background?: string;
  selfConcept: string;
}

export interface CharacterPersonality {
  summary: string;
  traits: string[];
  values: string[];
  likes: string[];
  dislikes: string[];
  speechStyle: string;
  boundaries: string[];
}

export interface RelationshipAndUser {
  type: string;
  history: string;
  interactionStyle: string;
  addressUserAs?: string;
  userPersona: {
    name: string;
    identity?: string;
    appearance?: string;
    background?: string;
  };
}

export interface WorldBookEntry {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  constant?: boolean;
  keywords: string[];
  priority: number;
}

export interface WorldAndScene {
  worldview: string;
  currentScene?: string;
  greeting?: string;
  stayInCharacter: boolean;
  worldBook: WorldBookEntry[];
}

export interface ExampleDialog {
  user: string;
  character: string;
}

export type ProactiveCapabilityConfigScalar = boolean | number | string;

export interface ProactiveCapabilityPreferenceV1 {
  enabled?: boolean;
  config?: Record<string, ProactiveCapabilityConfigScalar>;
}

export type ProactiveCapabilityPreferencesV1 = Record<string, ProactiveCapabilityPreferenceV1>;

export interface PerformanceAndCapabilities {
  responseStyle: string;
  initiative: 'low' | 'medium' | 'high';
  narration: 'none' | 'light' | 'rich';
  /** FEAT-CROSS-18 · 玩家可见的 GoalAgent 非终态进展密度；旧角色卡缺省为 balanced。 */
  progressReportLevel?: 'quiet' | 'balanced' | 'talkative';
  exampleDialogs: ExampleDialog[];
  capabilities: {
    chat: boolean;
    memory: boolean;
    minecraft: boolean;
    voice?: boolean;
  };
  /** FEAT-CROSS-25 · Catalog-driven proactive Tick switches and per-plugin settings. */
  proactiveCapabilities?: ProactiveCapabilityPreferencesV1;
}

/** FEAT-CROSS-12: four-part role-play card. */
export interface CharacterCardV1 {
  schemaVersion: 1;
  character: {
    identity: CharacterIdentity;
    personality: CharacterPersonality;
  };
  relationship: RelationshipAndUser;
  world: WorldAndScene;
  performance: PerformanceAndCapabilities;
}

export interface CharacterCardValidationError {
  path: string;
  code: 'required' | 'too_long' | 'too_many' | 'invalid' | 'unsupported_version';
  message: string;
}
