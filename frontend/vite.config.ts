import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app calls the backend with relative paths (/api/..., /automl/...) so that
// nginx can proxy them in Docker. In `npm run dev` there is no nginx, so Vite
// proxies them instead. Override the targets with BACKEND_URL / AUTOML_URL when
// running the dev server against services on another host.
const backend = process.env.BACKEND_URL || 'http://localhost:4000';
const automl = process.env.AUTOML_URL || 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/automl': {
        target: automl,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/automl/, ''),
      },
    },
  },
});
