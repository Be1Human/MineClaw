#!/usr/bin/env node

import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxFileBytes = 10 * 1024 * 1024;
const allowedFixtureDatabase = 'test-case/fixtures/memory/chat-memory-testOwner.db';

const blockedDirectoryNames = new Set([
  '.agentmem',
  '.claude',
  '.codex',
  '.cursor',
  '.run-logs',
  '.tmp',
  '.workflow',
  '.worktrees',
  'cache',
  'data-gym',
  'mc-server',
  'node_modules',
  'opensource'
]);

const blockedPathPrefixes = [
  'apps/minecraft-companion/.runtime-logs/',
  'apps/minecraft-companion/data/',
  'apps/minefriend-site/release/',
  'benchmark/archive/',
  'benchmark/reports/',
  'test-case/archive/',
  'test-case/results/'
];

const requiredPaths = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.agents/README.md',
  'SECURITY.md',
  'RELEASE_PROVENANCE.md',
];
const requiredSkillPaths = [
  'clawpm-project-workflow',
  'doc-style',
  'framework-first-debugging',
  'grill-me',
  'local-loop-test',
  'memory-benchmark',
  'minecraft-test-environment',
  'requirement-intake',
  'run',
  'test-doc'
].map((name) => `.agents/skills/${name}/SKILL.md`);
const secretRules = [
  { label: 'LLM API token', pattern: /\b[s]k-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { label: 'private key block', pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g },
  { label: 'credential URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^@\/\s:]+:[^@\/\s]+@/gi },
  { label: 'plain RCON password', pattern: /(^|\n)\s*rcon\.password\s*=\s*(?!\s*(?:$|#|<|\$\{))[^\s#]+/gim }
];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function forbiddenPath(relativePath) {
  const parts = relativePath.split('/');
  if (parts.some((part) => blockedDirectoryNames.has(part))) return true;
  if (blockedPathPrefixes.some((prefix) => relativePath.startsWith(prefix))) return true;

  const baseName = parts.at(-1);
  if (baseName === '.env.example') return false;
  if (baseName === '.env' || baseName.startsWith('.env.')) return true;
  if (baseName.endsWith('.log') || baseName.endsWith('.pem') || baseName.endsWith('.key')) return true;
  if (baseName.includes('.db') && relativePath !== allowedFixtureDatabase) return true;
  return false;
}

async function collectFiles(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      files.push({ relative: childRelative, symbolicLink: true });
    } else if (entry.isDirectory()) {
      files.push(...await collectFiles(childPath, childRelative));
    } else if (entry.isFile()) {
      files.push({ relative: childRelative, path: childPath });
    }
  }
  return files;
}

const violations = [];
for (const required of [...requiredPaths, ...requiredSkillPaths]) {
  try {
    await lstat(path.join(root, required));
  } catch {
    violations.push(`missing required governance file: ${required}`);
  }
}

const files = await collectFiles(root);
for (const file of files) {
  const relativePath = toPosix(file.relative);
  if (file.symbolicLink) {
    violations.push(`symbolic links are not allowed: ${relativePath}`);
    continue;
  }
  if (forbiddenPath(relativePath)) {
    violations.push(`forbidden path: ${relativePath}`);
    continue;
  }

  const stat = await lstat(file.path);
  if (stat.size > maxFileBytes) {
    violations.push(`file exceeds ${maxFileBytes} bytes: ${relativePath}`);
    continue;
  }

  const content = await readFile(file.path);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const rule of secretRules) {
    if (text.match(rule.pattern)) {
      violations.push(`${rule.label} detected: ${relativePath}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Release hygiene failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Release hygiene passed: ${files.length} files checked.`);
}
