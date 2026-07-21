import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web dev server on 5273; API on 5274 (see server/src/server.ts and between.config.json).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://localhost:5274',
    },
  },
});
