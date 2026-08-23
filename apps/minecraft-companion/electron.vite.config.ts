import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      outDir: resolve('out/main'),
      lib: {
        entry: resolve('electron/main.ts'),
      },
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      outDir: resolve('out/preload'),
      lib: {
        entry: resolve('electron/preload.ts'),
      },
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('web'),
    // DesktopPet3D composes skinview3d objects with the app renderer. Keep a
    // single Three.js object graph in both dev and packaged Electron bundles.
    resolve: {
      dedupe: ['three'],
    },
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: {
          index: resolve('web/index.html'),
          desktopPet: resolve('web/desktop-pet.html'),
        },
      },
    },
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:3000',
        '/socket.io': { target: 'http://localhost:3000', ws: true },
      },
    },
  },
})
