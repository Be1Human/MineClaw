import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:3000';
  const devPort = Number.parseInt(env.VITE_DEV_PORT || '5173', 10);
  const devHost = env.VITE_DEV_HOST || undefined;
  return {
    plugins: [vue()],
    // skinview3d declares its own older Three.js dependency. The desktop pet
    // combines its PlayerObject with the application's renderer, so both sides
    // must resolve to the same Three.js instance or the skin material is lost.
    resolve: {
      dedupe: ['three'],
    },
    server: {
      host: devHost,
      port: Number.isFinite(devPort) ? devPort : 5173,
      proxy: {
        '/api': backendUrl,
        '/socket.io': { target: backendUrl, ws: true },
      },
    },
  };
});
