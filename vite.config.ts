import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    hmr: false,
  },
  plugins: [],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
