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
      host: 'localhost',
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
    // PERF-006: the renderer used to ship as one 1.05 MiB chunk. Split the
    // heavy terminal runtime and the framework out so first paint does not
    // parse and compile everything at once.
    build: {
      chunkSizeWarningLimit: 500, // KB; warn if any chunk exceeds 500 KB
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
