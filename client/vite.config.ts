import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const clientDir = dirname(fileURLToPath(import.meta.url));
const version = readFileSync(resolve(clientDir, '../VERSION'), 'utf8').trim();

export default defineConfig({
  root: clientDir,
  publicDir: resolve(clientDir, '../public'),
  define: {
    __BUILD_INFO__: JSON.stringify({ version, builtAt: new Date().toISOString() }),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000' },
  },
  build: {
    outDir: resolve(clientDir, '../dist'),
    emptyOutDir: true,
  },
});
