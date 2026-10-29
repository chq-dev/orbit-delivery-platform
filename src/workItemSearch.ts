import type { WorkItem } from './types'

export interface WorkItemSearchResult {
  items: WorkItem[]
  total: number
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('zh-CN')
}

function searchableText(item: WorkItem): string {
  return [
    item.id,
    item.externalId,
    item.title,
    item.owner,
    item.projectLine,
    item.feishuStatus,
    item.branch,
    item.type === 'requirement' ? '需求 requirement' : '缺陷 defect bug',
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('zh-CN')
}

function matchRank(item: WorkItem, query: string, terms: string[]): number | undefined {
  const text = searchableText(item)
  if (!terms.every((term) => text.includes(term))) return undefined

  const id = normalize(item.id)
  const title = normalize(item.title)
  if (id === query) return 0
  if (id.startsWith(query)) return 1
  if (title.startsWith(query)) return 2
  if (id.includes(query)) return 3
  if (title.includes(query)) return 4
  if (terms.every((term) => id.includes(term) || title.includes(term))) return 5
  return 6
}

export function searchWorkItems(
  items: WorkItem[],
  rawQuery: string,
  limit = 50,
): WorkItemSearchResult {
  const query = normalize(rawQuery)
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50
    return { items: items.slice(0, safeLimit), total: items.length }
  }

  const matches = items
    .map((item, index) => ({ item, index, rank: matchRank(item, query, terms) }))
    .filter((entry): entry is { item: WorkItem; index: number; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50
  return {
    items: matches.slice(0, safeLimit).map((entry) => entry.item),
    total: matches.length,
  }
}
