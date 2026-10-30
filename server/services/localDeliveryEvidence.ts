const DELIVERY_ARTIFACT_PREFIX = 'delivery-artifacts/'
const DOCUMENT_FILE_PATTERN = /\.(?:md|markdown|txt)$/i

export function normalizeDeliveryPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

export function isDeliveryCodeFile(file: string): boolean {
  const path = normalizeDeliveryPath(file)
  if (!path || path.startsWith(DELIVERY_ARTIFACT_PREFIX)) return false
  return !DOCUMENT_FILE_PATTERN.test(path)
}

export function deliveryCodeFiles(files: readonly string[]): string[] {
  return [...new Set(files.map(normalizeDeliveryPath).filter(isDeliveryCodeFile))]
}

export function deliveryCommitMessage(workItemId: string, title: string): string {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim() || '本地交付'
  return `${workItemId}: ${normalizedTitle}`.slice(0, 240)
}
