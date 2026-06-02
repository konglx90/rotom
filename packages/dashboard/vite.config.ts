import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  // xterm ships as CommonJS (no `exports` map / no `module` field). Listing
  // it here makes vite pre-bundle it with esbuild so the import-analysis
  // step doesn't choke in dev mode.
  optimizeDeps: {
    include: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:28800',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: './dist/src/master/dashboard',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
})
