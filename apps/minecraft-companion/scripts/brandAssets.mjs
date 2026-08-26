import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const canonicalSvg = resolve(appDir, '..', 'minefriend-site', 'public', 'brand', 'mineclaw-mark.svg');
const appSvg = join(appDir, 'web', 'public', 'brand', 'mineclaw-mark.svg');
const appPng = join(appDir, 'build', 'icon.png');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`品牌栅格不是有效 PNG：${appPng}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function writeIfChanged(source, target) {
  const next = await readFile(source);
  const current = await readFile(target).catch(() => null);
  if (current && current.equals(next)) return false;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('exit', code => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} 失败（code=${code}）\n${stdout}\n${stderr}`));
    });
  });
}

async function resolveEdge() {
  const candidates = [
    process.env.MINECLAW_EDGE_PATH,
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function renderWithEdge(target) {
  const edge = await resolveEdge();
  if (!edge) return false;
  await run(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    '--window-size=512,512',
    `--screenshot=${target}`,
    pathToFileURL(canonicalSvg).href,
  ]);
  return true;
}

async function renderWithBuilder(target, tempRoot) {
  const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js');
  const setDir = join(tempRoot, 'set');
  await runIconsTool({ inputFile: canonicalSvg, outputFormat: 'set', outDir: setDir });
  const candidates = (await readdir(setDir))
    .map(name => ({ name, match: /^(\d+)x(\d+)\.png$/i.exec(name) }))
    .filter(value => value.match)
    .map(value => ({
      name: value.name,
      width: Number(value.match[1]),
      height: Number(value.match[2]),
    }))
    .filter(value => value.width === value.height && value.width >= 512)
    .sort((left, right) => left.width - right.width);
  if (candidates.length === 0) {
    throw new Error('品牌图标工具未生成至少 512×512 的正方形 PNG');
  }
  const preferred = candidates.find(value => value.width === 512) ?? candidates[0];
  await copyFile(join(setDir, preferred.name), target);
}

async function renderPng() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mineclaw-brand-'));
  try {
    const generated = join(tempRoot, 'icon.png');
    if (!(await renderWithEdge(generated))) await renderWithBuilder(generated, tempRoot);
    await mkdir(dirname(appPng), { recursive: true });
    const next = await readFile(generated);
    const current = await readFile(appPng).catch(() => null);
    if (!current || !current.equals(next)) await copyFile(generated, appPng);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function verify() {
  if (!(await exists(canonicalSvg))) throw new Error(`找不到正式品牌源：${canonicalSvg}`);
  if (!(await exists(appSvg))) throw new Error(`找不到 app 品牌 SVG：${appSvg}；请运行 npm run brand:sync`);
  if (!(await exists(appPng))) throw new Error(`找不到 app 品牌 PNG：${appPng}；请运行 npm run brand:sync`);

  const canonical = await readFile(canonicalSvg);
  const svg = await readFile(appSvg);
  if (!canonical.equals(svg)) {
    throw new Error('app 品牌 SVG 已落后于正式品牌源；请运行 npm run brand:sync');
  }

  const png = await readFile(appPng);
  const dimensions = pngDimensions(png);
  if (dimensions.width !== dimensions.height || dimensions.width < 512) {
    throw new Error(`品牌 PNG 必须为至少 512×512 的正方形，当前为 ${dimensions.width}×${dimensions.height}`);
  }

  console.log(JSON.stringify({
    source: canonicalSvg,
    svg: { path: appSvg, sha256: sha256(svg) },
    png: { path: appPng, sha256: sha256(png), ...dimensions },
  }));
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  if (mode === '--sync') {
    const svgChanged = await writeIfChanged(canonicalSvg, appSvg);
    await renderPng();
    await verify();
    console.log(`[brand] 同步完成（SVG ${svgChanged ? '已更新' : '无变化'}）`);
    return;
  }
  if (mode === '--check') {
    await verify();
    return;
  }
  throw new Error(`未知参数：${mode}；可用 --sync 或 --check`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
