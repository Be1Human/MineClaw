const DEFAULT_HUB_URLS = ['http://127.0.0.1:3000', 'http://localhost:3000'];
const DEFAULT_RENDERER_URLS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

export async function resolveElectronDevStrategy({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const hubCandidates = env.MINECLAW_DEV_HUB_URL
    ? [normalizeUrl(env.MINECLAW_DEV_HUB_URL)]
    : DEFAULT_HUB_URLS;
  const rendererCandidates = env.MINECLAW_DEV_RENDERER_URL
    ? [normalizeUrl(env.MINECLAW_DEV_RENDERER_URL)]
    : DEFAULT_RENDERER_URLS;
  const [hubUrl, rendererUrl] = await Promise.all([
    findHealthyUrl(hubCandidates, '/api/profiles', fetchImpl),
    findHealthyUrl(rendererCandidates, '/', fetchImpl),
  ]);
  return hubUrl && rendererUrl
    ? { mode: 'attach', hubUrl, rendererUrl }
    : {
        mode: 'standalone',
        hubUrl: hubUrl || hubCandidates[0],
        rendererUrl: rendererUrl || rendererCandidates[0],
      };
}

async function findHealthyUrl(candidates, path, fetchImpl) {
  for (const candidate of candidates) {
    if (await probe(`${candidate}${path}`, fetchImpl)) return candidate;
  }
  return undefined;
}

async function probe(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  return String(value).trim().replace(/\/$/, '');
}
