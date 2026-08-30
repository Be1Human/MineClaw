import type {
  MemorySlotCapturePolicy,
  MemorySlotDefinition,
  MemorySlotSensitivity,
  MemorySlotValueType,
} from './contracts.js';

export const MEMORY_SLOT_CATALOG_VERSION = 1;

type SlotSeed = readonly [
  key: string,
  title: string,
  type: MemorySlotValueType,
  capture: MemorySlotCapturePolicy,
  aliases?: readonly string[],
  sensitivity?: MemorySlotSensitivity,
];

function group(groupName: string, seeds: readonly SlotSeed[]): MemorySlotDefinition[] {
  return seeds.map(([slotKey, title, valueType, capturePolicy, aliases = [], sensitivity = capturePolicy === 'explicit_only' ? 'private' : 'normal']) => ({
    slotKey,
    catalogVersion: MEMORY_SLOT_CATALOG_VERSION,
    group: groupName,
    title,
    description: `用户的${title}`,
    valueType,
    maxItems: valueType === 'set' ? 12 : 1,
    sensitivity,
    capturePolicy,
    conflictPolicy: valueType === 'set' ? 'merge_set' : valueType === 'structured' ? 'manual_review' : 'replace',
    recallAliases: [...new Set([title, ...aliases, ...slotKey.split('.')])],
    promptPriority: slotKey.startsWith('boundary.') || slotKey === 'identity.preferred_name' ? 'P0'
      : slotKey.startsWith('identity.') || slotKey.startsWith('commitment.') ? 'P1'
        : 'P2',
  }));
}

export const MEMORY_SLOT_CATALOG: readonly MemorySlotDefinition[] = Object.freeze([
  ...group('身份与称呼', [
    ['identity.preferred_name', '偏好称呼', 'scalar', 'automatic', ['叫我', '称呼']],
    ['identity.pronouns', '代词/称谓', 'set', 'explicit_only'],
    ['identity.language.primary', '主要语言', 'scalar', 'automatic'],
    ['identity.language.additional', '其他语言', 'set', 'automatic'],
    ['identity.timezone', '时区', 'scalar', 'corroborated'],
    ['identity.region', '所在地区', 'scalar', 'explicit_only'],
    ['identity.birthday', '生日', 'date', 'explicit_only'],
    ['identity.occupation', '职业概况', 'scalar', 'corroborated'],
    ['identity.study_field', '学习领域', 'set', 'automatic'],
    ['identity.self_description', '自我描述', 'set', 'corroborated'],
  ]),
  ...group('沟通与互动', [
    ['communication.reply_length', '回复长度偏好', 'enum', 'automatic', ['简短回复', '详细回复']],
    ['communication.reply_tone', '回复语气偏好', 'set', 'automatic'],
    ['communication.formality', '正式程度', 'enum', 'automatic'],
    ['communication.humor_style', '幽默风格', 'set', 'automatic'],
    ['communication.emoji_preference', '表情使用偏好', 'enum', 'automatic'],
    ['communication.proactive_level', '主动程度偏好', 'enum', 'automatic'],
    ['communication.explanation_depth', '解释深度', 'enum', 'automatic'],
    ['communication.language_style', '语言风格', 'set', 'automatic'],
    ['communication.address_style', '称呼方式', 'scalar', 'automatic'],
    ['communication.feedback_style', '反馈方式偏好', 'set', 'automatic'],
  ]),
  ...group('饮食与饮品', [
    ['preference.food.favorite', '喜欢的食物', 'set', 'automatic', ['喜欢吃', '爱吃', '食物偏好', '吃什么']],
    ['preference.food.dislike', '不喜欢的食物', 'set', 'automatic', ['不喜欢吃', '讨厌吃', '忌口']],
    ['preference.food.allergy', '食物过敏', 'set', 'explicit_only', ['过敏'], 'restricted'],
    ['preference.food.diet', '饮食方式', 'set', 'corroborated'],
    ['preference.food.cuisine', '喜欢的菜系', 'set', 'automatic'],
    ['preference.food.flavor', '口味偏好', 'set', 'automatic'],
    ['preference.food.spice_level', '辣度偏好', 'enum', 'automatic'],
    ['preference.food.texture', '口感偏好', 'set', 'automatic'],
    ['preference.food.breakfast', '早餐偏好', 'set', 'automatic'],
    ['preference.food.snack', '零食偏好', 'set', 'automatic'],
    ['preference.food.dessert', '甜点偏好', 'set', 'automatic'],
    ['preference.drink.favorite', '喜欢的饮品', 'set', 'automatic', ['喜欢喝', '饮料偏好']],
    ['preference.drink.dislike', '不喜欢的饮品', 'set', 'automatic', ['不喜欢喝']],
    ['preference.drink.caffeine', '咖啡因偏好', 'enum', 'corroborated'],
    ['preference.food.cooking_style', '烹饪偏好', 'set', 'automatic'],
  ]),
  ...group('娱乐与文化', [
    ['preference.music.genre', '音乐类型', 'set', 'automatic'],
    ['preference.music.artist', '音乐人', 'set', 'automatic'],
    ['preference.music.song', '歌曲', 'set', 'automatic'],
    ['preference.movie.genre', '电影类型', 'set', 'automatic'],
    ['preference.movie.title', '电影', 'set', 'automatic'],
    ['preference.tv.genre', '剧集类型', 'set', 'automatic'],
    ['preference.tv.title', '剧集', 'set', 'automatic'],
    ['preference.book.genre', '书籍类型', 'set', 'automatic'],
    ['preference.book.title', '书籍', 'set', 'automatic'],
    ['preference.game.genre', '游戏类型', 'set', 'automatic'],
    ['preference.game.title', '游戏', 'set', 'automatic'],
    ['preference.creator', '内容创作者', 'set', 'automatic'],
    ['preference.podcast', '播客', 'set', 'automatic'],
    ['preference.anime', '动画/动漫', 'set', 'automatic'],
    ['preference.cultural_style', '文化风格', 'set', 'automatic'],
  ]),
  ...group('兴趣与爱好', [
    ['interest.hobby', '日常爱好', 'set', 'automatic'],
    ['interest.sport', '运动兴趣', 'set', 'automatic'],
    ['interest.outdoor', '户外兴趣', 'set', 'automatic'],
    ['interest.creative', '创作兴趣', 'set', 'automatic'],
    ['interest.technology', '科技兴趣', 'set', 'automatic'],
    ['interest.science', '科学兴趣', 'set', 'automatic'],
    ['interest.history', '历史兴趣', 'set', 'automatic'],
    ['interest.art', '艺术兴趣', 'set', 'automatic'],
    ['interest.travel', '旅行兴趣', 'set', 'automatic'],
    ['interest.pets_animals', '宠物与动物兴趣', 'set', 'automatic'],
    ['interest.collecting', '收藏兴趣', 'set', 'automatic'],
    ['interest.learning', '学习兴趣', 'set', 'automatic'],
  ]),
  ...group('生活方式与日常', [
    ['lifestyle.sleep_schedule', '作息时间', 'structured', 'corroborated'],
    ['lifestyle.work_schedule', '工作时段', 'structured', 'corroborated'],
    ['lifestyle.meal_schedule', '用餐习惯', 'structured', 'corroborated'],
    ['lifestyle.exercise_routine', '运动习惯', 'set', 'corroborated'],
    ['lifestyle.weekend_routine', '周末习惯', 'set', 'corroborated'],
    ['lifestyle.productivity_style', '效率习惯', 'set', 'automatic'],
    ['lifestyle.planning_style', '计划方式', 'set', 'automatic'],
    ['lifestyle.social_energy', '社交节奏', 'enum', 'corroborated'],
    ['lifestyle.environment_preference', '环境偏好', 'set', 'automatic'],
    ['lifestyle.travel_style', '出行风格', 'set', 'automatic'],
  ]),
  ...group('关系与社交', [
    ['relationship.important_people', '重要的人', 'structured', 'explicit_only'],
    ['relationship.family', '家庭成员', 'structured', 'explicit_only'],
    ['relationship.partner', '伴侣', 'structured', 'explicit_only'],
    ['relationship.friends', '朋友', 'structured', 'explicit_only'],
    ['relationship.pets', '宠物', 'structured', 'automatic'],
    ['relationship.social_boundaries', '社交边界', 'set', 'explicit_only'],
    ['relationship.celebration_days', '纪念日', 'structured', 'explicit_only'],
    ['relationship.shared_activities', '常一起做的事', 'structured', 'corroborated'],
  ]),
  ...group('工作、学习与项目', [
    ['work.role', '当前角色', 'scalar', 'corroborated'],
    ['work.industry', '行业领域', 'set', 'corroborated'],
    ['work.tools', '常用工具', 'set', 'automatic'],
    ['work.current_focus', '工作重点', 'set', 'corroborated'],
    ['study.stage', '学习阶段', 'scalar', 'corroborated'],
    ['study.subject', '当前科目', 'set', 'automatic'],
    ['study.learning_goal', '学习目标', 'set', 'corroborated'],
    ['project.current', '当前长期项目', 'structured', 'corroborated'],
    ['project.stack', '项目技术栈', 'set', 'automatic'],
    ['project.collaboration_style', '协作方式', 'set', 'automatic'],
  ]),
  ...group('边界、照顾与安全', [
    ['boundary.avoid_topic', '避免的话题', 'set', 'explicit_only', [], 'restricted'],
    ['boundary.avoid_wording', '避免的措辞', 'set', 'explicit_only', [], 'restricted'],
    ['boundary.avoid_action', '避免的行为', 'set', 'explicit_only', [], 'restricted'],
    ['care.comfort_preference', '安慰方式', 'set', 'explicit_only', [], 'private'],
    ['care.accessibility_need', '无障碍需求', 'structured', 'explicit_only', [], 'restricted'],
    ['care.safety_note', '安全注意事项', 'structured', 'explicit_only', [], 'restricted'],
  ]),
  ...group('目标与承诺', [
    ['goal.short_term', '短期目标', 'structured', 'corroborated'],
    ['goal.long_term', '长期目标', 'structured', 'corroborated'],
    ['commitment.current', '当前承诺', 'structured', 'corroborated'],
    ['reminder.important_date', '重要日期', 'structured', 'explicit_only'],
  ]),
]);

const slotByKey = new Map(MEMORY_SLOT_CATALOG.map(definition => [definition.slotKey, definition]));
const opposingSlotByKey = new Map<string, string>([
  ['preference.food.favorite', 'preference.food.dislike'],
  ['preference.food.dislike', 'preference.food.favorite'],
  ['preference.drink.favorite', 'preference.drink.dislike'],
  ['preference.drink.dislike', 'preference.drink.favorite'],
]);

if (MEMORY_SLOT_CATALOG.length !== 100 || slotByKey.size !== 100) {
  throw new Error(`[MemorySlotCatalog] v1 must contain exactly 100 unique slots; got ${MEMORY_SLOT_CATALOG.length}/${slotByKey.size}`);
}

export function getMemorySlotDefinition(slotKey: string): MemorySlotDefinition | null {
  return slotByKey.get(slotKey) ?? null;
}

export function getOpposingMemorySlotKey(slotKey: string): string | null {
  return opposingSlotByKey.get(slotKey) ?? null;
}

export function searchMemorySlotDefinitions(query: string, limit = 8): MemorySlotDefinition[] {
  const tokens = normalizedTokens(query);
  if (tokens.length === 0) return [];
  return MEMORY_SLOT_CATALOG
    .map(definition => ({ definition, score: slotScore(definition, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.definition.slotKey.localeCompare(b.definition.slotKey))
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(item => item.definition);
}

function slotScore(definition: MemorySlotDefinition, queryTokens: string[]): number {
  const candidates = normalizedTokens([
    definition.title,
    definition.group,
    definition.description,
    ...definition.recallAliases,
  ].join(' '));
  return queryTokens.reduce((score, token) => score + candidates.reduce((best, candidate) => {
    if (candidate === token) return Math.max(best, 4);
    if (candidate.includes(token) || token.includes(candidate)) return Math.max(best, Math.min(token.length, candidate.length) >= 2 ? 2 : 0);
    return best;
  }, 0), 0);
}

function normalizedTokens(text: string): string[] {
  const compact = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  if (!compact) return [];
  const words = compact.split(' ').filter(Boolean);
  const cjk = [...compact.replace(/[^\p{Script=Han}]/gu, '')];
  const grams: string[] = [];
  for (let index = 0; index < cjk.length; index += 1) {
    grams.push(cjk[index]!);
    if (index + 1 < cjk.length) grams.push(`${cjk[index]}${cjk[index + 1]}`);
    if (index + 2 < cjk.length) grams.push(`${cjk[index]}${cjk[index + 1]}${cjk[index + 2]}`);
  }
  return [...new Set([...words, ...grams])];
}
