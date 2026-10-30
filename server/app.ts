import express, { type ErrorRequestHandler } from 'express'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { config } from './config.js'
import type { AppDatabase } from './db/database.js'
import { AppError } from './domain/errors.js'
import { createApiRouter } from './routes.js'
import { parseSessionCookie } from './security/sessionCookie.js'
import type { CredentialVault } from './security/vault.js'
import { userForSessionToken } from './services/authService.js'
import { readFeishuSnapshotFromDatabase } from './services/feishuSnapshotService.js'

export function createApp(db: AppDatabase, vault: CredentialVault) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxy)
  app.use((request, response, next) => {
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'same-origin')
    if (request.secure) {
      response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }
    if (config.requireHttps && !request.secure) {
      const host = request.headers.host
      if (host) {
        response.redirect(308, `https://${host}${request.originalUrl}`)
        return
      }
      response.status(426).json({
        error: { code: 'HTTPS_REQUIRED', message: '当前平台只接受 HTTPS 请求' },
      })
      return
    }
    next()
  })
  app.use((request, response, next) => {
    if (!String(request.headers['accept-encoding'] ?? '').includes('gzip')) {
      next()
      return
    }
    const originalJson = response.json.bind(response)
    response.json = ((body: unknown) => {
      const payload = JSON.stringify(body)
      if (Buffer.byteLength(payload) < 1024) return originalJson(body)
      const compressed = gzipSync(payload, { level: 6 })
      response.setHeader('content-encoding', 'gzip')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('vary', 'accept-encoding')
      response.setHeader('content-length', String(compressed.length))
      response.end(request.method === 'HEAD' ? undefined : compressed)
      return response
    }) as unknown as typeof response.json
    next()
  })
  app.use(
    express.json({
      limit: '2mb',
      verify: (request, _response, buffer) => {
        ;(request as typeof request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer)
      },
    }),
  )
  app.use('/api', (_request, response, next) => {
    response.setHeader('cache-control', 'no-store')
    next()
  })
  app.use('/api', createApiRouter(db, vault))

  app.get('/feishu-work-items.json', (request, response, next) => {
    try {
      const token = parseSessionCookie(request.headers.cookie)
      if (!userForSessionToken(db, token)) {
        response.status(401).json({
          error: { code: 'AUTH_REQUIRED', message: '请先登录后再访问飞书快照' },
        })
        return
      }
      const snapshot = readFeishuSnapshotFromDatabase(db, config.feishuProjectKey)
      if (!snapshot) {
        next()
        return
      }
      response.setHeader('cache-control', 'no-store')
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })

  const webRoot = resolve(process.cwd(), 'dist')
  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.use(
      express.static(webRoot, {
        index: false,
        maxAge: '1h',
        setHeaders: (response, path) => {
          if (path.endsWith('index.html') || path.endsWith('feishu-work-items.json')) {
            response.setHeader('cache-control', 'no-store')
          }
        },
      }),
    )
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next()
      response.setHeader('cache-control', 'no-store')
      response.sendFile(resolve(webRoot, 'index.html'))
    })
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message, details: error.details },
      })
      return
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({
        error: { code: 'INVALID_JSON', message: '请求体不是合法的 JSON' },
      })
      return
    }
    const sqliteCode = (error as { code?: string }).code
    if (sqliteCode?.startsWith('SQLITE_CONSTRAINT')) {
      response.status(409).json({
        error: { code: 'CONSTRAINT_VIOLATION', message: '数据约束冲突，请检查唯一字段或关联关系' },
      })
      return
    }
    console.error(error)
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: '服务内部错误' },
    })
  }
  app.use(errorHandler)

  return app
}
