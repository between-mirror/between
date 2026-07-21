import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Between Mirror — the browser-only demo build.
//
// A separate config, and a separate entry (src/demo/main-demo.tsx), so the installed application can
// never contain the shim that answers reads from frozen files and refuses writes. Two configs is the
// enforcement; a runtime flag inside one bundle would be a promise.
//
// `base: './'` is what lets the output be served from any path — /between/demo/ on the project site,
// something else on a fork — without rebuilding. An absolute base would nail the bundle to one URL,
// and the first person to fork this would get a blank page and no idea why.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(__dirname, '../site/demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'demo.html'),
    },
  },
});
