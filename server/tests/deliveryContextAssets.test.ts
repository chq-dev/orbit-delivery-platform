import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { materializeDeliveryScreenshots } from '../services/deliveryContextAssets.js'

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
