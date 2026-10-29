import type { WorkItem, WorkItemStatus, WorkItemType } from './types'

export type WorkItemTypeFilter = 'all' | WorkItemType
export type WorkItemStatusFilter = 'all' | WorkItemStatus

export interface WorkItemFilters {
  type: WorkItemTypeFilter
  platformStatus: WorkItemStatusFilter
  feishuStatus: string
  projectLine: string
  owner: string
  search: string
}

export function splitWorkItemValues(value?: string): string[] {
  if (!value) return []
  return [...new Set(value.split(/[,，]/).map((entry) => entry.trim()).filter(Boolean))]
}

export function collectWorkItemFilterValues(
  items: WorkItem[],
  field: 'feishuStatus' | 'projectLine' | 'owner',
): string[] {
  const values = new Set<string>()
  for (const item of items) {
    if (field === 'feishuStatus') {
      if (item.feishuStatus?.trim()) values.add(item.feishuStatus.trim())
      continue
    }
    for (const value of splitWorkItemValues(item[field])) values.add(value)
  }
  return [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function filterWorkItems(items: WorkItem[], filters: WorkItemFilters): WorkItem[] {
  const search = filters.search.trim().toLocaleLowerCase('zh-CN')
  return items.filter((item) => {
    if (filters.type !== 'all' && item.type !== filters.type) return false
    if (filters.platformStatus !== 'all' && item.status !== filters.platformStatus) return false
    if (filters.feishuStatus && item.feishuStatus !== filters.feishuStatus) return false
    if (filters.projectLine && !splitWorkItemValues(item.projectLine).includes(filters.projectLine)) {
      return false
    }
    if (filters.owner && !splitWorkItemValues(item.owner).includes(filters.owner)) return false
    if (!search) return true
    return [
      item.id,
      item.title,
      item.owner,
      item.branch,
      item.externalId,
      item.feishuStatus,
      item.projectLine,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(search)
  })
}

export function hasActiveWorkItemFilters(filters: WorkItemFilters): boolean {
  return (
    filters.type !== 'all' ||
    filters.platformStatus !== 'all' ||
    Boolean(filters.feishuStatus || filters.projectLine || filters.owner || filters.search.trim())
  )
}
