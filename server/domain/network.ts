const networkErrorLabels: Record<string, string> = {
  ENOTFOUND: 'DNS 解析失败',
  EAI_AGAIN: 'DNS 解析暂时失败',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '响应头超时',
  UND_ERR_BODY_TIMEOUT: '响应体超时',
  UND_ERR_SOCKET: '连接异常关闭',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书为自签名证书',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书链包含自签名证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链校验失败',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS 根证书不受信任',
}

function detailParts(value: unknown, seen: Set<unknown>): string[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  const record = value as Record<string, unknown>
  const parts: string[] = []
  const code = typeof record.code === 'string' ? record.code : ''
  if (code) {
    const label = networkErrorLabels[code]
    parts.push(label ? `${label}（${code}）` : code)
  }

  for (const key of ['hostname', 'address', 'syscall']) {
    const detail = record[key]
    if (typeof detail === 'string' && detail && !parts.some((part) => part.includes(detail))) {
      parts.push(detail)
    }
  }
  const port = record.port
  if (typeof port === 'number' || (typeof port === 'string' && port)) {
    parts.push(`端口 ${String(port)}`)
  }

  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      for (const part of detailParts(nested, seen)) {
        if (!parts.includes(part)) parts.push(part)
      }
    }
  }

  const message = typeof record.message === 'string' ? record.message : ''
  if (message && !parts.some((part) => part.includes(message))) parts.push(message)
  return parts
}

export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const headline =
    error.name === 'TimeoutError' || error.name === 'AbortError'
      ? '请求超时'
      : error.message || error.name
  const details = detailParts((error as Error & { cause?: unknown }).cause, new Set())
  return details.length > 0 ? `${headline}（${details.join('；')}）` : headline
}
