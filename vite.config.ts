import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
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
      // Proxy Reddit JSON API to avoid CORS issues in dev
      '/api/reddit': {
        target: 'https://www.reddit.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/reddit/, ''),
      },
    },
  },
});

