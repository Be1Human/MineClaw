import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    outDir: 'release/mineclaw-showcase',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        architecture: fileURLToPath(new URL('./architecture.html', import.meta.url)),
      },
    },
  },
});
