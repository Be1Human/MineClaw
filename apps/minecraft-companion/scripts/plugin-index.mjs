#!/usr/bin/env node
/**
 * Builtin plugin index generator (kernel design §5.4, P2/P3).
 *
 * Scans first-party plugin directories under src/bot/v2/plugins/builtin (one
 * directory per package, each with a plugin.yaml), validates manifests against
 * the Plugin SDK, statically collects the import graph of each code entry (for
 * the static-dependency gate), and emits:
 *   - builtin-manifest.generated.json  (manifest + entryKey + imports)
 *   - builtin-index.generated.ts       (static factory mapping, no dynamic import)
 *
 * Output is committed; runtime never scans source. Test and CI regenerate and
 * diff (pluginPackaging.test.mjs).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import ts from 'typescript';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const sourceRoot = join(root, 'src', 'bot', 'v2');
const defaultPluginsRoot = join(sourceRoot, 'plugins', 'builtin');
const kernelRoot = join(sourceRoot, 'plugin-kernel');
const defaultManifestOut = join(kernelRoot, 'builtin-manifest.generated.json');
const defaultIndexOut = join(kernelRoot, 'builtin-index.generated.ts');

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?[^'"]*?(?:from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Collect declared import/export specifiers of an entry module (AST-based, no false strings). */
function collectImports(entryFile) {
  const source = readFileSync(entryFile, 'utf8');
  const sourceFile = ts.createSourceFile(entryFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const result = [];
  for (const specifier of new Set(specifiers)) {
    if (!specifier.startsWith('.')) { result.push(specifier); continue; }
    const resolved = new URL(specifier.replace(/\.js$/, '.ts'), `file://${entryFile.replace(/\\/g, '/')}`);
    const target = fileURLToPath(resolved).replace(/\\/g, '/');
    if (existsSync(target)) {
      const rootPath = sourceRoot.replace(/\\/g, '/');
      result.push(target.slice(rootPath.length + 1));
    }
  }
  return result;
}

function validateManifest(rawManifest, pluginDir) {
  const issues = [];
  let manifest;
  try {
    manifest = parse(rawManifest);
  } catch {
    issues.push('invalid YAML');
    return { manifest: null, issues };
  }
  if (typeof manifest !== 'object' || manifest === null) { issues.push('manifest must be an object'); return { manifest, issues }; }
  if (manifest.schema !== 'mineclaw.plugin/v1') issues.push(`schema must be mineclaw.plugin/v1 (got ${manifest.schema})`);
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) issues.push(`invalid id ${manifest.id}`);
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) issues.push(`invalid version ${manifest.version}`);
  if (!['data', 'domain', 'system'].includes(manifest.kind)) issues.push(`invalid kind ${manifest.kind}`);
  if (manifest.kind === 'data' && manifest.entry !== undefined) issues.push('data plugin must not declare a code entry');
  if (manifest.kind !== 'data' && typeof manifest.entry !== 'string') issues.push(`${manifest.kind} plugin requires a code entry`);
  if (!Array.isArray(manifest.contributions) || manifest.contributions.length === 0) issues.push('contributions must be non-empty');
  const contributionIds = new Set();
  for (const [index, contribution] of (manifest.contributions ?? []).entries()) {
    if (typeof contribution.id !== 'string' || !contribution.id.startsWith(`${manifest.id}.`)) issues.push(`contribution[${index}].id must live in ${manifest.id}.*`);
    if (contributionIds.has(contribution.id)) issues.push(`duplicate contribution ${contribution.id}`);
    contributionIds.add(contribution.id);
    if (typeof contribution.version !== 'string' || !SEMVER_RE.test(contribution.version)) issues.push(`contribution[${index}] version invalid`);
  }
  return { manifest, issues };
}

function resolveEntry(pluginDir, manifest) {
  if (typeof manifest.entry !== 'string') return null;
  const base = join(pluginDir, manifest.entry.replace(/\.(m?ts|m?js)$/, ''));
  for (const path of [`${base}.ts`, `${base}.mts`, join(pluginDir, 'index.ts')]) {
    if (existsSync(path)) return path;
  }
  return null;
}

function pascal(value) {
  return value.split(/[.-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function exportName(pluginId, kind) {
  return kind === 'system' ? `create${pascal(pluginId)}SystemPlugin` : `create${pascal(pluginId)}Plugin`;
}

export class PluginIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginIndexError';
  }
}

/**
 * Build the builtin index. Throws PluginIndexError on any invalid package;
 * writes nothing when any package fails (fail-closed output).
 */
export function buildPluginIndex({
  scanRoot = defaultPluginsRoot,
  outManifest = defaultManifestOut,
  outIndex = defaultIndexOut,
  entryResolver = resolveEntry,
  importCollector = collectImports,
} = {}) {
  const pluginDirs = existsSync(scanRoot)
    ? readdirSync(scanRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => join(scanRoot, entry.name))
    : [];
  const plugins = [];
  const seenIds = new Set();
  const issues = [];
  for (const pluginDir of pluginDirs) {
    const manifestPath = join(pluginDir, 'plugin.yaml');
    if (!existsSync(manifestPath)) { issues.push(`plugin directory ${pluginDir} is missing plugin.yaml`); continue; }
    const rawManifest = readFileSync(manifestPath, 'utf8');
    const { manifest, issues: manifestIssues } = validateManifest(rawManifest, pluginDir);
    if (manifestIssues.length) { issues.push(...manifestIssues.map(issue => `${manifestPath}: ${issue}`)); continue; }
    if (seenIds.has(manifest.id)) { issues.push(`duplicate plugin id ${manifest.id}`); continue; }
    seenIds.add(manifest.id);
    let entryFile = null;
    if (manifest.kind !== 'data') {
      entryFile = entryResolver(pluginDir, manifest);
      if (!entryFile) { issues.push(`entry not found for ${manifest.id} (${manifest.entry})`); continue; }
    }
    const imports = entryFile ? importCollector(entryFile) : [];
    plugins.push({
      pluginId: manifest.id,
      kind: manifest.kind,
      entryKey: `plugins/builtin/${manifest.id}`,
      entryFile,
      manifest: rawManifest,
      manifestHash: createHash('sha256').update(rawManifest).digest('hex'),
      imports: Object.freeze(imports),
    });
  }
  if (issues.length > 0) {
    throw new PluginIndexError(issues.join('\n'));
  }
  const json = {
    generatedAt: new Date().toISOString(),
    schema: 'mineclaw.builtin-index/v1',
    plugins: plugins.map(plugin => ({
      pluginId: plugin.pluginId,
      kind: plugin.kind,
      entryKey: plugin.entryKey,
      manifestHash: plugin.manifestHash,
      manifest: parse(plugin.manifest),
      imports: plugin.imports,
    })),
  };
  const lines = [
    '/* AUTO-GENERATED by scripts/plugin-index.mjs — do not edit. */',
    'import type { PluginFactory } from \'../discovery.js\';',
  ];
  for (const plugin of plugins) {
    if (!plugin.entryFile) continue;
    const modulePath = relative(kernelRoot, plugin.entryFile).replace(/\\/g, '/').replace(/\.ts$/, '');
    lines.push(`import { ${exportName(plugin.pluginId, plugin.kind)} } from './${modulePath}';`);
  }
  lines.push('');
  lines.push('/** Static factory mapping (build-generated; runtime never dynamic-imports). */');
  lines.push('export const BUILTIN_PLUGIN_FACTORIES: ReadonlyMap<string, PluginFactory> = new Map([');
  for (const plugin of plugins) {
    if (!plugin.entryFile) continue;
    lines.push(`  ['${plugin.entryKey}', ${exportName(plugin.pluginId, plugin.kind)}],`);
  }
  lines.push(']);');
  writeFileSync(outManifest, JSON.stringify(json, null, 2), 'utf8');
  writeFileSync(outIndex, lines.join('\n'), 'utf8');
  return { plugins, manifestOut: outManifest, indexOut: outIndex };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/plugin-index.mjs')) {
  const cli = process.argv.slice(2);
  const args = {};
  for (let index = 0; index < cli.length; index += 2) args[cli[index]] = cli[index + 1];
  try {
    const result = buildPluginIndex({
      scanRoot: args['--root'] ? join(args['--root']) : defaultPluginsRoot,
      outManifest: args['--out-json'] ? join(args['--out-json']) : defaultManifestOut,
      outIndex: args['--out-ts'] ? join(args['--out-ts']) : defaultIndexOut,
    });
    console.log(`[plugin-index] ${result.plugins.length} builtin plugin(s) -> ${relative(root, result.manifestOut)}, ${relative(root, result.indexOut)}`);
  } catch (error) {
    console.error(`[plugin-index] failed:\n${error.message}`);
    process.exit(1);
  }
}
