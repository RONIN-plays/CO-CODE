import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Forward WebSocket traffic to the Node server during development.
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
