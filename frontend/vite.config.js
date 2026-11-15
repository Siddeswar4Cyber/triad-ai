import { defineConfig } from 'vite'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    watch: { usePolling: true },
    proxy: {
      '/api': 'http://backend:5000',
    },
  },
})