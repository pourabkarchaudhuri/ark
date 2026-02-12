import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  define: {
    // Inject the package.json version at build time so the changelog modal
    // and navbar always match — no more manual APP_VERSION bumps.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    strictPort: true, // fail if 5173 is in use so Electron always loads correct URL
    proxy: {
      // Proxy Steam News API to avoid CORS issues in dev / Electron renderer
      '/api/steam-news': {
        target: 'https://api.steampowered.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/steam-news/, '/ISteamNews/GetNewsForApp/v2'),
      },
    },
  },
});

