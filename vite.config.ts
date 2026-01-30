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
  },
});

