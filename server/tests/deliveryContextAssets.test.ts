import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  materializeDeliveryScreenshots,
  parseDeliveryScreenshots,
} from '../services/deliveryContextAssets.js'
import {
  DELIVERY_SCREENSHOT_REQUEST_MAX_BYTES,
  MAX_DELIVERY_SCREENSHOTS,
  MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES,
} from '../../src/deliveryContext.js'

function screenshot(bytes = Buffer.from('design-image')) {
  return {
    name: '设计稿.png',
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  }
}

test('需求截图会安全写入交付工件目录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-delivery-context-'))
  try {
    const content = Buffer.from('design-image')
    const paths = materializeDeliveryScreenshots(directory, [
      {
        name: '../设计稿.png',
        mimeType: 'image/png',
        sizeBytes: content.length,
        dataUrl: `data:image/png;base64,${content.toString('base64')}`,
      },
    ])
    assert.equal(paths.length, 1)
    assert.match(paths[0] ?? '', /requirement-assets\/_设计稿\.png$/)
    assert.deepEqual(readFileSync(paths[0] ?? ''), content)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('本机代理最多接收 10 张前端暂存截图', () => {
  const accepted = parseDeliveryScreenshots(
    Array.from({ length: MAX_DELIVERY_SCREENSHOTS }, () => screenshot()),
  )
  assert.equal(accepted.length, MAX_DELIVERY_SCREENSHOTS)
  assert.throws(
    () =>
      parseDeliveryScreenshots(
        Array.from({ length: MAX_DELIVERY_SCREENSHOTS + 1 }, () => screenshot()),
      ),
    /最多上传 10 张/,
  )
})

test('本机代理拒绝非图片和超限截图', () => {
  assert.throws(
    () => parseDeliveryScreenshots([{ ...screenshot(), mimeType: 'image/svg+xml' }]),
    /仅支持 PNG、JPEG 或 WebP/,
  )
  assert.throws(
    () => parseDeliveryScreenshots([screenshot(Buffer.alloc(501 * 1024, 1))]),
    /超过 500KB/,
  )
})

test('截图请求体上限覆盖 Base64 膨胀后的最大体积', () => {
  const encodedMaxBytes = Math.ceil((MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES * 4) / 3)
  assert.ok(DELIVERY_SCREENSHOT_REQUEST_MAX_BYTES > encodedMaxBytes)
})
