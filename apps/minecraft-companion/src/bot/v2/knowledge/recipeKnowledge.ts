/**
 * Knowledge · RecipeKnowledgeSource — 合成配方领域知识（与 RecipeResolver 同源）
 *
 * BUG-CROSS-80：GoalAgent 的 domainKnowledge 此前只加载能力包 Markdown，合成配方
 * 虽存在于 getCraftRecipes 却不可被 knowledge_search 召回。本模块把配方事实转换为
 * DomainKnowledgeDocument，与执行层 RecipeResolver 共用同一个 RecipeDataSource，
 * 配方数字零手写、不漂移。
 */
import { createHash } from 'node:crypto';
import type { DomainKnowledgeDocument } from './domainKnowledge.js';
import { domainKnowledgeRef } from './domainKnowledge.js';
import type { RecipeDataSource } from './recipeResolver.js';

export interface RecipeKnowledgeItem {
  /** 物品 id（不带 minecraft: 前缀） */
  id: string;
  /** 中文/口语别名（用于知识召回，取第一个作为显示名） */
  aliases: readonly string[];
}

export interface BuildRecipeKnowledgeOptions {
  items: readonly RecipeKnowledgeItem[];
  data: RecipeDataSource;
  /** 每物品最多收录的配方套数，默认 3 */
  maxRecipesPerItem?: number;
}

export function buildRecipeKnowledgeDocuments(options: BuildRecipeKnowledgeOptions): DomainKnowledgeDocument[] {
  const maxRecipes = options.maxRecipesPerItem ?? 3;
  const documents: DomainKnowledgeDocument[] = [];
  const seen = new Set<string>();
  for (const rawItem of options.items) {
    const item = rawItem.id.trim().toLowerCase().replace(/^minecraft:/, '');
    if (!item || seen.has(item)) continue;
    seen.add(item);
    const document = buildOne(item, rawItem.aliases, options.data, maxRecipes);
    if (document) documents.push(document);
  }
  return documents;
}

function buildOne(
  item: string,
  aliases: readonly string[],
  data: RecipeDataSource,
  maxRecipes: number,
): DomainKnowledgeDocument | null {
  const recipes = safeRecipes(data, item)
    .filter(recipe => Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0)
    .slice(0, maxRecipes);
  const source = safeSource(data, item);
  if (recipes.length === 0 && !source) return null;

  const lines: string[] = [];
  for (const recipe of recipes) {
    const ingredients = recipe.ingredients
      .map(ingredient => `${ingredient.name}×${ingredient.count}`)
      .join(' + ');
    const table = recipe.requiresTable ? '需工作台' : '2×2 随身合成';
    lines.push(`- ${item} = ${ingredients}（${table}），产出 ${recipe.result.count} 个`);
  }
  if (recipes.length === 0 && source) {
    lines.push(
      `- ${item} 是采集物：挖 ${source.block}` +
      `${source.requiredTool ? `（需 ${source.requiredTool}）` : '（空手或任意工具）'}`,
    );
  }
  if (lines.length === 0) return null;

  const display = aliases.find(alias => alias.trim())?.trim() ?? item;
  const id = `recipe:${item}`;
  const title = `如何获得 ${display}（${item}）`;
  const summary = recipes.length > 0
    ? `合成 ${display} 的配方（${recipes.length} 套，与执行层配方同源）`
    : `采集 ${display} 的来源`;
  const tags = [
    'recipe', 'craft', '合成', '物品', item,
    ...(recipes.length > 0 ? ['craftable'] : ['gatherable']),
  ];
  const body = lines.join('\n');
  const canonical = JSON.stringify({ id, title, summary, tags, body });
  const version = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  const ref = domainKnowledgeRef(id);
  return Object.freeze({
    id,
    title,
    summary,
    tags: Object.freeze(tags),
    body,
    sourcePath: `recipe-data:${item}`,
    ref,
    version,
    evidenceRef: `${ref}@${version}`,
    estimatedTokens: Math.max(1, Math.ceil(Buffer.byteLength(body, 'utf8') / 3)),
  } satisfies DomainKnowledgeDocument);
}

function safeRecipes(data: RecipeDataSource, item: string) {
  try {
    return data.getCraftRecipes(item, true);
  } catch {
    return [];
  }
}

function safeSource(data: RecipeDataSource, item: string) {
  try {
    return data.getItemSource(item);
  } catch {
    return null;
  }
}
