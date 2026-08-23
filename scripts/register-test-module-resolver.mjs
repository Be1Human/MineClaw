import { register } from 'node:module';

register('./test-module-resolver.mjs', import.meta.url);
