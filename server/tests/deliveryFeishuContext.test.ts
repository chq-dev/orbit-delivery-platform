import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractFeishuImageUrls,
  extractFeishuMediaReferences,
} from '../services/deliveryFeishuContext.js'

test('飞书缺陷内容可提取 Markdown、HTML、协议相对和 srcset 图片', () => {
  const urls = extractFeishuImageUrls(`
静态图：![现象](https://project.feishu.cn/attachment/static-1.png)
动图：![复现](//project.feishu.cn/attachment/repro.gif)
HTML：<img data-src="https://project.feishu.cn/attachment/static-2.webp?x=1&amp;y=2">
响应式：<source srcset="https://project.feishu.cn/attachment/static-3.jpg 1x, https://project.feishu.cn/attachment/static-4.jpg 2x">
转义：<img src="https:\\/\\/project.feishu.cn\\/attachment\\/repro.webp">
重复：<img src="https://project.feishu.cn/attachment/static-1.png">
`)
  assert.deepEqual(urls, [
    'https://project.feishu.cn/attachment/static-1.png',
    'https://project.feishu.cn/attachment/repro.gif',
    'https://project.feishu.cn/attachment/static-2.webp?x=1&y=2',
    'https://project.feishu.cn/attachment/static-3.jpg',
    'https://project.feishu.cn/attachment/static-4.jpg',
    'https://project.feishu.cn/attachment/repro.webp',
  ])
})

test('飞书缺陷内容忽略非绝对图片地址', () => {
  assert.deepEqual(
    extractFeishuImageUrls(
      '<img src="/relative.png"><img src="data:image/png;base64,abc"><img src="ftp://example.com/a.png">',
    ),
    [],
  )
})

test('飞书缺陷内容可区分图片和 MP4 视频附件', () => {
  const references = extractFeishuMediaReferences(`
图片：![现象](https://project.feishu.cn/attachment/static.png)
视频标签：<video poster="https://project.feishu.cn/attachment/poster.jpg"><source src="https://project.feishu.cn/attachment/repro"></video>
视频链接：[录屏](https://project.feishu.cn/attachment/demo.mp4)
裸链接：https://project.feishu.cn/attachment/demo-2.mp4?download=1
`)
  assert.deepEqual(references, [
    { url: 'https://project.feishu.cn/attachment/static.png', kind: 'image' },
    {
      url: 'https://project.feishu.cn/attachment/repro',
      kind: 'video',
    },
    {
      url: 'https://project.feishu.cn/attachment/poster.jpg',
      kind: 'image',
    },
    {
      url: 'https://project.feishu.cn/attachment/demo.mp4',
      kind: 'video',
    },
    {
      url: 'https://project.feishu.cn/attachment/demo-2.mp4?download=1',
      kind: 'video',
    },
  ])
  assert.deepEqual(extractFeishuImageUrls('<video src="https://x.test/a.mp4"></video>'), [])
})
