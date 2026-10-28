export function durationSeconds(value: string): number | null {
  const match = value.match(/(\d+)m\s*(\d+)s/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function averageDuration(values: string[]): string {
  const durations = values
    .map((value) => durationSeconds(value))
    .filter((value): value is number => value !== null)
  if (durations.length === 0) return '-'
  return formatDuration(durations.reduce((sum, value) => sum + value, 0) / durations.length)
}
