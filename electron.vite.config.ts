import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { defineConfig, externalizeDepsPlugin, bytecodePlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import uno from 'unocss/vite'

function mainBytecodePlugin() {
  const plugin = bytecodePlugin({ removeBundleJS: true })
  if (!plugin) return null
  const require = createRequire(import.meta.url)
  return {
    ...plugin,
    closeBundle() {},
    async writeBundle(options: { dir?: string }, bundle: Record<string, { type: string; fileName: string }>) {
      if (!options.dir) throw new Error('Missing bytecode output directory')
      if (Object.values(bundle).some(file => file.type === 'chunk' && file.fileName !== 'index.js')) {
        throw new Error('Main bytecode build requires a single bundle')
      }
      const entry = resolve(options.dir, 'index.js')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      const result = spawnSync(require('electron'), [resolve('scripts/compile-main-bytecode.cjs'), entry], {
        env, encoding: 'utf8', windowsHide: true, timeout: 60_000
      })
      if (result.error || result.status !== 0) throw new Error(`Bytecode compilation failed: ${result.error || result.stderr}`)
      writeFileSync(resolve(options.dir, 'bytecode-loader.cjs'), readFileSync(resolve('scripts/main-bytecode-loader.cjs')))
      writeFileSync(entry, 'require("./bytecode-loader.cjs");\nrequire("./index.jsc");\n')
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), mainBytecodePlugin(), {
      name: 'main-commonjs-package',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'package.json', source: '{"type":"commonjs"}' })
        this.emitFile({ type: 'asset', fileName: 'bytecode-target.json', source: JSON.stringify({ platform: process.platform, arch: process.arch }) })
      }
    }],
    build: {
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: 'esbuild',
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
      sourcemap: false,
      minify: 'esbuild',
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
