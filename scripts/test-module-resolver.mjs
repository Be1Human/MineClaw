import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromApplication = createRequire(new URL('../apps/minecraft-companion/package.json', import.meta.url));
const requireFromWeb = createRequire(new URL('../apps/minecraft-companion/web/package.json', import.meta.url));

function isBareSpecifier(specifier) {
  return !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('node:')
    && !specifier.startsWith('file:')
    && !specifier.startsWith('data:');
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!isBareSpecifier(specifier) || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    for (const resolver of [requireFromApplication, requireFromWeb]) {
      try {
        const resolved = resolver.resolve(specifier);
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      } catch (resolutionError) {
        if (resolutionError?.code !== 'MODULE_NOT_FOUND') throw resolutionError;
      }
    }
    throw error;
  }
}
