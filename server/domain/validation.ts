import { unprocessable } from './errors.js'

export function requiredText(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const min = options.min ?? 1
  const max = options.max ?? 10_000
  if (text.length < min) throw unprocessable(`${field}不能为空`)
  if (text.length > max) throw unprocessable(`${field}长度不能超过 ${max} 个字符`)
  return text
}

export function optionalText(value: unknown, field: string, max = 10_000): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, field, { max })
}

export function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw unprocessable(`${field}必须是以下值之一：${allowed.join('、')}`)
  }
  return value as T
}

export function booleanValue(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw unprocessable(`${field}必须是布尔值`)
  return value
}

export function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw unprocessable(`${field}必须是数组`)
  if (value.length === 0) throw unprocessable(`${field}不能为空`)
  if (value.length > 500) throw unprocessable(`${field}单次最多导入 500 条`)
  return value
}

export function httpUrl(value: unknown, field: string): string {
  const text = requiredText(value, field, { max: 2_000 })
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw unprocessable(`${field}不是合法的 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw unprocessable(`${field}仅支持 http/https 协议`)
  }
  return text
}
