export const DEFAULT_PAGE_SIZE = 50
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]
export type PageToken = number | 'ellipsis'

export function getPageCount(totalItems: number, pageSize: number): number {
  const size = Math.max(1, Math.trunc(pageSize) || 1)
  const total = Math.max(0, Math.trunc(totalItems) || 0)
  return Math.max(1, Math.ceil(total / size))
}

export function clampPage(page: number, totalItems: number, pageSize: number): number {
  const normalized = Number.isFinite(page) ? Math.trunc(page) : 1
  return Math.min(Math.max(1, normalized), getPageCount(totalItems, pageSize))
}

export function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  const safePage = clampPage(page, items.length, pageSize)
  const size = Math.max(1, Math.trunc(pageSize) || 1)
  const start = (safePage - 1) * size
  return items.slice(start, start + size)
}

export function buildPageTokens(currentPage: number, totalPages: number): PageToken[] {
  const total = Math.max(1, Math.trunc(totalPages) || 1)
  const current = Math.min(Math.max(1, Math.trunc(currentPage) || 1), total)
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)

  const pages = new Set<number>([1, total, current])
  for (let page = Math.max(2, current - 1); page <= Math.min(total - 1, current + 1); page += 1) {
    pages.add(page)
  }
  if (current <= 3) {
    for (let page = 2; page <= 4; page += 1) pages.add(page)
  }
  if (current >= total - 2) {
    for (let page = total - 4; page < total; page += 1) pages.add(page)
  }

  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b)
  const tokens: PageToken[] = []
  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0 && sorted[index] - sorted[index - 1] > 1) tokens.push('ellipsis')
    tokens.push(sorted[index])
  }
  return tokens
}
