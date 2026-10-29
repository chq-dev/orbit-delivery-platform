import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPageTokens,
  clampPage,
  getPageCount,
  paginateItems,
} from '../../src/pagination'

test('前端分页计算页码、切片并处理越界', () => {
  assert.equal(getPageCount(0, 50), 1)
  assert.equal(getPageCount(5_701, 50), 115)
  assert.equal(clampPage(0, 5_701, 50), 1)
  assert.equal(clampPage(999, 5_701, 50), 115)
  assert.deepEqual(paginateItems([1, 2, 3, 4, 5], 2, 2), [3, 4])
  assert.deepEqual(paginateItems([1, 2, 3, 4, 5], 0, 2), [1, 2])
})

test('前端分页页码在首尾和中间正确显示省略号', () => {
  assert.deepEqual(buildPageTokens(1, 5), [1, 2, 3, 4, 5])
  assert.deepEqual(buildPageTokens(1, 115), [1, 2, 3, 4, 'ellipsis', 115])
  assert.deepEqual(buildPageTokens(58, 115), [1, 'ellipsis', 57, 58, 59, 'ellipsis', 115])
  assert.deepEqual(buildPageTokens(114, 115), [1, 'ellipsis', 111, 112, 113, 114, 115])
})
