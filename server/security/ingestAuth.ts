import { timingSafeEqual } from 'node:crypto'
import { AppError } from '../domain/errors.js'

export interface IngestRequestIdentity {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]?.trim() ?? ''
  return value?.trim() ?? ''
}

function bearerToken(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headerValue(headers, 'authorization')
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim()
  }
  return headerValue(headers, 'x-feishu-ingest-token')
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false
  const normalized = ip.toLowerCase()
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized.startsWith('127.')
  )
}

function hasForwardedAddress(headers: Record<string, string | string[] | undefined>): boolean {
  return Boolean(
    headerValue(headers, 'forwarded') ||
      headerValue(headers, 'x-forwarded-for') ||
      headerValue(headers, 'x-real-ip'),
  )
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function assertFeishuIngestAuthorized(
  request: IngestRequestIdentity,
  expectedToken: string,
): void {
  if (!expectedToken) {
    if (isLoopback(request.ip) && !hasForwardedAddress(request.headers)) return
    throw new AppError(
      503,
      'FEISHU_INGEST_TOKEN_NOT_CONFIGURED',
      '外部飞书同步必须配置 FEISHU_INGEST_TOKEN；本机回环请求除外',
    )
  }

  const token = bearerToken(request.headers)
  if (!token || !safeEqual(token, expectedToken)) {
    throw new AppError(401, 'FEISHU_INGEST_UNAUTHORIZED', '飞书同步凭证无效')
  }
}
