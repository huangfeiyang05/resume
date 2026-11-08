import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'admin'),
  base: '/admin/',
  build: { outDir: resolve(import.meta.dirname, 'dist/admin'), emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001' } },
  },
});
