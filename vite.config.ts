import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const emptyFeishuSnapshot = JSON.stringify({
  version: 1,
  source: 'feishu',
  projectKey: 'rjcloud',
  syncedAt: '',
  items: [],
})

function readFeishuSnapshot(): string {
  const path = resolve(process.cwd(), 'data/feishu-work-items.json')
  if (!existsSync(path)) return emptyFeishuSnapshot
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return emptyFeishuSnapshot
  }
}

function feishuSnapshotPlugin(): Plugin {
  return {
    name: 'orbit-feishu-snapshot',
    configureServer(server) {
      server.middlewares.use('/feishu-work-items.json', (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.end(readFeishuSnapshot())
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'feishu-work-items.json',
        source: readFeishuSnapshot(),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), feishuSnapshotPlugin()],
  server: {
    port: 4173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
