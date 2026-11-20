import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

// Backend for `npm run dev`. Defaults to a local Outband/MeshCentral on 4432;
// `npm run dev:mock` points it at the mock server instead.
const target = process.env.OUTBAND_BACKEND ?? 'https://localhost:4432';

export default defineConfig({
  base: '/',
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true, secure: false, ws: true },
    },
  },
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: true,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
