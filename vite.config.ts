import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const keyPath = resolve(env.HTTPS_KEY_PATH || 'data/tls/orbit-key.pem')
  const certPath = resolve(env.HTTPS_CERT_PATH || 'data/tls/orbit-cert.pem')
  const tlsAvailable = existsSync(keyPath) && existsSync(certPath)
  const proxyTarget =
    env.VITE_API_PROXY_TARGET || (tlsAvailable ? 'https://127.0.0.1:8787' : 'http://localhost:8787')
  return {
    plugins: [react()],
    server: {
      port: 4173,
      host: true,
      ...(tlsAvailable
        ? { https: { key: readFileSync(keyPath), cert: readFileSync(certPath) } }
        : {}),
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/feishu-work-items.json': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
