import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import uno from 'unocss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 20222,
      strictPort: true
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@renderer': resolve(dirname(fileURLToPath(import.meta.url)), 'src/renderer/src')
      }
    },
    plugins: [react(), uno()],
    build: {
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('xterm')) return 'xterm'
            if (id.includes('lucide')) return 'vendor'
            if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
            return 'vendor'
          }
        }
      }
    }
  }
})
