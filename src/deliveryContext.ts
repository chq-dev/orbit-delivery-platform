export const REQUIREMENT_BREAKDOWN_MIN_LENGTH = 20
export const MAX_DELIVERY_SCREENSHOTS = 3
export const MAX_DELIVERY_SCREENSHOT_BYTES = 500 * 1024
export const MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES = 1_200 * 1024

export const DELIVERY_SCREENSHOT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
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
