#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const GAME_VERSION = '1.21.1';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = resolve(appRoot, 'builtin-packs', 'mineclaw-open-blocks.zip');
const files = unzipSync(readFileSync(archivePath));
const baselineRoot = `assets/minecraft/mineclaw-baseline/${GAME_VERSION}`;
const states = readJson(`${baselineRoot}/blocks_states.json`);
const baselineModels = readJson(`${baselineRoot}/blocks_models.json`);
const tints = readJson(`${baselineRoot}/tints.json`);
const modelReferences = new Set();

for (const blockState of Object.values(states)) collectApplications(blockState).forEach(application => {
  if (application?.model) modelReferences.add(application.model);
});

const missingModels = [];
const resolvedModels = new Map();
for (const name of modelReferences) {
  try {
    resolvedModels.set(name, resolveModel(name));
  } catch (error) {
    missingModels.push(`${name}: ${error.message}`);
  }
}

const textureReferences = new Set();
for (const model of resolvedModels.values()) {
  for (const value of Object.values(model.textures ?? {})) {
    const resolved = resolveTexture(value, model.textures ?? {});
    if (resolved) textureReferences.add(resolved);
  }
  for (const element of model.elements ?? []) for (const face of Object.values(element.faces ?? {})) {
    const resolved = resolveTexture(face?.texture, model.textures ?? {});
    if (resolved) textureReferences.add(resolved);
  }
}

const missingTextures = Array.from(textureReferences).filter(texture => !files[texturePath(texture)]).sort();
const overlayModels = Object.keys(files).filter(path => path.startsWith('assets/minecraft/models/block/') && path.endsWith('.json'));
let overlayParentsResolved = 0;
for (const path of overlayModels) {
  const name = `minecraft:${path.slice('assets/minecraft/models/'.length, -'.json'.length)}`;
  try {
    resolveModel(name);
    overlayParentsResolved += 1;
  } catch (error) {
    missingModels.push(`${name}: ${error.message}`);
  }
}

const requiredTints = ['grass', 'foliage', 'water', 'redstone', 'constant'];
const missingTints = requiredTints.filter(kind => !Array.isArray(tints[kind]?.data));
const summary = {
  gameVersion: GAME_VERSION,
  blockStates: Object.keys(states).length,
  baselineModels: Object.keys(baselineModels).length,
  referencedModels: modelReferences.size,
  resolvedModels: resolvedModels.size,
  overlayModels: overlayModels.length,
  overlayParentsResolved,
  textureReferences: textureReferences.size,
  missingTextureCount: missingTextures.length,
  missingTextureSample: missingTextures.slice(0, 30),
  missingModels,
  missingTints,
  provenancePresent: Boolean(files['MINECLAW-PROVENANCE.json'] && files['MINECRAFT-ASSETS-NOTICE.json']),
};

console.log(JSON.stringify(summary, null, 2));
if (missingModels.length || missingTints.length || !summary.provenancePresent || overlayParentsResolved !== overlayModels.length) {
  process.exitCode = 1;
}

function collectApplications(blockState) {
  const applications = [];
  for (const value of Object.values(blockState?.variants ?? {})) applications.push(...asArray(value));
  for (const part of blockState?.multipart ?? []) applications.push(...asArray(part?.apply));
  return applications.filter(Boolean);
}

function resolveModel(name, stack = []) {
  if (stack.includes(name) || stack.length > 64) throw new Error(`cyclic parent ${[...stack, name].join(' -> ')}`);
  const model = loadModel(name);
  if (!model) throw new Error('model not found');
  if (!model.parent) return { ...model, textures: { ...(model.textures ?? {}) } };
  const parent = resolveModel(model.parent, [...stack, name]);
  return {
    ...parent,
    ...model,
    textures: { ...(parent.textures ?? {}), ...(model.textures ?? {}) },
    elements: model.elements ?? parent.elements,
  };
}

function loadModel(name) {
  const location = resourceLocation(name);
  if (location.namespace !== 'minecraft') return null;
  const overlayPath = `assets/minecraft/models/${location.path}.json`;
  if (files[overlayPath]) return readJson(overlayPath);
  return baselineModels[location.path.replace(/^block\//, '')] ?? null;
}

function resolveTexture(reference, textures) {
  let current = typeof reference === 'string' ? reference : null;
  const seen = new Set();
  while (current?.startsWith('#')) {
    const key = current.slice(1);
    if (seen.has(key)) return null;
    seen.add(key);
    current = textures[key];
  }
  return typeof current === 'string' ? current : null;
}

function texturePath(texture) {
  const location = resourceLocation(texture);
  return `assets/${location.namespace}/textures/${location.path}.png`;
}

function resourceLocation(value) {
  const normalized = String(value ?? '').replace(/^#/, '');
  const separator = normalized.indexOf(':');
  return separator < 0
    ? { namespace: 'minecraft', path: normalized }
    : { namespace: normalized.slice(0, separator), path: normalized.slice(separator + 1) };
}

function readJson(path) {
  const bytes = files[path];
  if (!bytes) throw new Error(`missing ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}
