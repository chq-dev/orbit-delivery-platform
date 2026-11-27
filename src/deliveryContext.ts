export const REQUIREMENT_BREAKDOWN_MIN_LENGTH = 20
export const MAX_DELIVERY_SCREENSHOTS = 10
export const MAX_DELIVERY_SCREENSHOT_BYTES = 500 * 1024
export const MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES =
  MAX_DELIVERY_SCREENSHOTS * MAX_DELIVERY_SCREENSHOT_BYTES

// Base64 编码会让体积膨胀约 4/3，再为 JSON 字段与请求头预留 4MB。
export const DELIVERY_SCREENSHOT_REQUEST_MAX_BYTES =
  Math.ceil((MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES * 4) / 3) + 4 * 1024 * 1024

export const DELIVERY_SCREENSHOT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

export type DeliveryScreenshotMimeType = (typeof DELIVERY_SCREENSHOT_MIME_TYPES)[number]

export function isDeliveryScreenshotMimeType(value: string): value is DeliveryScreenshotMimeType {
  return DELIVERY_SCREENSHOT_MIME_TYPES.includes(value as DeliveryScreenshotMimeType)
}

export interface DeliveryScreenshotUpload {
  name: string
  mimeType: DeliveryScreenshotMimeType
  sizeBytes: number
  dataUrl: string
}

export interface RequirementDeliveryContextLike {
  requirementBreakdown?: string
  designReference?: string
  screenshotCount?: number
}

export interface DefectResolutionLike {
  legacyBug?: boolean
  introduced?: boolean
  solution?: string
  rootCause?: string
  impact?: string
}

export const DEFECT_RESOLUTION_TEXT_MAX_LENGTH = 10_000

export function isMeaningfulRequirementBreakdown(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length >= REQUIREMENT_BREAKDOWN_MIN_LENGTH
}

export function hasRequirementDeliveryContext(
  context: RequirementDeliveryContextLike,
): boolean {
  return (
    isMeaningfulRequirementBreakdown(context.requirementBreakdown) ||
    Boolean(context.designReference?.trim()) ||
    (context.screenshotCount ?? 0) > 0
  )
}

export function requirementDeliveryContextIssue(
  context: RequirementDeliveryContextLike,
): string | undefined {
  if (hasRequirementDeliveryContext(context)) return undefined
  return `需求交付前必须提供需求拆解（至少 ${REQUIREMENT_BREAKDOWN_MIN_LENGTH} 字）、设计稿链接/本地路径，或至少一张设计截图`
}

export function defectResolutionIssue(
  resolution: DefectResolutionLike | undefined,
): string | undefined {
  if (!resolution) return '关闭飞书缺陷前必须生成是否遗留、是否修订引入、解决方案、根因分析和影响面'
  if (typeof resolution.legacyBug !== 'boolean') return '关闭飞书缺陷前必须生成是否遗留BUG'
  if (typeof resolution.introduced !== 'boolean') return '关闭飞书缺陷前必须生成是否修订引入'
  const missing = [
    ['解决方案', resolution.solution],
    ['根因分析', resolution.rootCause],
    ['影响面分析', resolution.impact],
  ].find(([, value]) => typeof value !== 'string' || value.trim().length === 0)
  if (missing) return `关闭飞书缺陷前必须生成${missing[0]}`
  return undefined
}
