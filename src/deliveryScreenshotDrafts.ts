import type { DeliveryScreenshotUpload } from './deliveryContext'

const DATABASE_NAME = 'orbit-delivery-drafts'
const STORE_NAME = 'screenshots'
const DATABASE_VERSION = 1

interface DeliveryScreenshotDraft {
  workItemId: string
  screenshots: DeliveryScreenshotUpload[]
  updatedAt: string
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'workItemId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开本地截图暂存失败'))
  })
  const pending = opening.catch((error) => {
    databasePromise = null
    throw error
  })
  databasePromise = pending
  return pending
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取本地截图暂存失败'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('写入本地截图暂存失败'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('写入本地截图暂存已取消'))
  })
}

export async function loadDeliveryScreenshotDrafts(
  workItemId: string,
): Promise<DeliveryScreenshotUpload[]> {
  if (!workItemId) return []
  try {
    const database = await openDatabase()
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const record = await requestResult<DeliveryScreenshotDraft | undefined>(
      transaction.objectStore(STORE_NAME).get(workItemId),
    )
    return Array.isArray(record?.screenshots) ? record.screenshots : []
  } catch {
    return []
  }
}

export async function saveDeliveryScreenshotDrafts(
  workItemId: string,
  screenshots: DeliveryScreenshotUpload[],
): Promise<void> {
  if (!workItemId) return
  try {
    const database = await openDatabase()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    if (screenshots.length === 0) {
      store.delete(workItemId)
    } else {
      store.put({
        workItemId,
        screenshots,
        updatedAt: new Date().toISOString(),
      } satisfies DeliveryScreenshotDraft)
    }
    await transactionDone(transaction)
  } catch {
    // Draft storage is best-effort and must not block delivery.
  }
}

export async function clearDeliveryScreenshotDrafts(workItemId: string): Promise<void> {
  await saveDeliveryScreenshotDrafts(workItemId, [])
}
