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
        // /api/terminal 是 WebSocket,需要同时代理 ws 升级。
        ws: true,
      },
      // WebSocket 也走 vite 代理:前端连"同源 /ws"(见 SocketContext),
      // vite 转发到 master:28800。这样从 Pad/局域网访问 dev 时,
      // 客户端只需打通 :3000,不必直连 :28800。
      '/ws': {
        target: 'http://localhost:28800',
        changeOrigin: true,
        ws: true,
      },
    }
  },
  build: {
    outDir: './dist/src/master/dashboard',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's __vitePreload helper must live in its own chunk so it
          // doesn't drag monaco-core (2.5 MB) into index.js via a static
          // import. monaco-editor uses dynamic imports internally for its
          // own loaderWorker, which forces the helper into monaco-core by
          // default.
          if (id.includes('vite/preload-helper')) return 'vite-preload'
          if (id.includes('node_modules/monaco-editor')) return 'monaco-core'
          if (id.includes('node_modules/react-markdown') ||
              id.includes('node_modules/remark') ||
              id.includes('node_modules/unified') ||
              id.includes('node_modules/micromark') ||
              id.includes('node_modules/mdast')) {
            return 'markdown'
          }
          if (id.includes('node_modules/react') ||
              id.includes('node_modules/scheduler')) {
            return 'react-vendor'
          }
        },
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
})
