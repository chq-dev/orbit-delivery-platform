export function nowIso(): string {
  return new Date().toISOString()
}

export function formatDisplayTime(value: string | null | undefined): string {
  if (!value) return '-'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value

  const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  if (diffMinutes < 24 * 60) return `${Math.floor(diffMinutes / 60)} 小时前`
  if (diffMinutes < 48 * 60) return '昨天'
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function formatDuration(startIso: string | null, endIso = nowIso()): string {
  const start = startIso ? Date.parse(startIso) : Number.NaN
  const end = Date.parse(endIso)
  if (Number.isNaN(start) || Number.isNaN(end)) return '00m 01s'
  const totalSeconds = Math.max(1, Math.round((end - start) / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}
