import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildLocalDeliveryCommand,
  createLocalDeliveryAgentSteps,
  describeFetchError,
  fetchJsonWithRetry,
  parseLocalDeliveryAgentRequest,
  resolveLocalDeliveryTarget,
  supportsLocalDeliveryContract,
  updateLocalDeliveryAgentStep,
} from '../services/localDeliveryAgentService.js'

const request = {
  workItemId: 'REQ-1082',
  repoId: 'repo-1',
  autoCommit: true,
  pushAfterAcceptance: true,
  autoClose: true,
}

test('一键交付请求只接受受控参数，不允许浏览器下发本地路径', () => {
  assert.deepEqual(parseLocalDeliveryAgentRequest(request), request)
  assert.throws(
    () =>
      parseLocalDeliveryAgentRequest({
        ...request,
        localPath: '/Users/example/sme-main',
      }),
    /不支持交付参数：localPath/,
  )
  assert.throws(
    () => parseLocalDeliveryAgentRequest({ ...request, workItemId: '../shell' }),
    /工作项格式不正确/,
  )
  assert.throws(
    () => parseLocalDeliveryAgentRequest({ ...request, autoCommit: false }),
    /未启用自动提交时不能推送/,
  )
})

test('一键交付路径和分支只从平台仓库配置解析', () => {
  const target = resolveLocalDeliveryTarget(
    {
      repositories: [
        {
          id: 'repo-1',
          name: 'sme-main',
          localPath: '/Users/chenhuaqu/sme/sme-main',
          branch: 'dev-harvey',
        },
      ],
      workItems: [
        {
          id: 'REQ-1082',
          title: '测试需求',
          repoId: 'repo-1',
          branch: 'work-item-branch',
        },
      ],
    },
    request,
  )
  assert.equal(target.localPath, '/Users/chenhuaqu/sme/sme-main')
  assert.equal(target.branch, 'dev-harvey')
  assert.throws(
    () =>
      resolveLocalDeliveryTarget(
        {
          repositories: [{ id: 'repo-1', branch: 'dev-harvey' }],
          workItems: [{ id: 'REQ-1082' }],
        },
        request,
      ),
    /尚未配置当前客户端的代码路径/,
  )
})

test('本机代理的仓库路径映射优先于平台共享路径', () => {
  const target = resolveLocalDeliveryTarget(
    {
      repositories: [
        {
          id: 'repo-1',
          name: 'sme-main',
          localPath: '/Users/shinya/Documents/workspace/SME/basic-component-cloud',
          branch: 'dev-harvey',
        },
      ],
      workItems: [{ id: 'REQ-1082', repoId: 'repo-1' }],
    },
    request,
    { 'repo-1': '/Users/chenhuaqu/sme/sme-main' },
  )
  assert.equal(target.localPath, '/Users/chenhuaqu/sme/sme-main')
  assert.equal(target.branch, 'dev-harvey')
})

test('一键交付命令通过 argv 传递并自动授权推送确认', () => {
  assert.deepEqual(
    buildLocalDeliveryCommand({
      platformBaseUrl: 'http://8.145.45.84:8787',
      ...request,
      localPath: '/Users/chenhuaqu/sme/sme-main',
      branch: 'dev-harvey',
    }),
    [
      'run',
      'deliver:local',
      '--',
      '--api',
      'http://8.145.45.84:8787',
      '--work-item',
      'REQ-1082',
      '--repo',
      'repo-1',
      '--path',
      '/Users/chenhuaqu/sme/sme-main',
      '--branch',
      'dev-harvey',
      '--run',
      '--push',
      '--yes',
      '--close',
    ],
  )

  const localOnly = buildLocalDeliveryCommand({
    platformBaseUrl: 'http://8.145.45.84:8787',
    ...request,
    autoCommit: false,
    pushAfterAcceptance: false,
    autoClose: false,
    localPath: '/Users/chenhuaqu/sme/sme-main',
    branch: 'dev-harvey',
  })
  assert.equal(localOnly.includes('--no-commit'), true)
  assert.equal(localOnly.includes('--push'), false)
  assert.equal(localOnly.includes('--yes'), false)
  assert.equal(localOnly.includes('--close'), false)
})

test('旧服务端缺少交付契约字段时拒绝执行本机交付', () => {
  assert.equal(supportsLocalDeliveryContract({ status: 'ok' }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: undefined }), false)
  assert.equal(supportsLocalDeliveryContract(null), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 0 }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 1 }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: '2' }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 3 }), true)
})

test('本机交付步骤会记录运行、成功、失败与日志', () => {
  const steps = createLocalDeliveryAgentSteps()
  assert.equal(steps.length, 7)
  assert.equal(steps.every((step) => step.status === 'pending'), true)
  const running = updateLocalDeliveryAgentStep(steps, 'platform', 'running', '连接平台')
  assert.equal(running?.status, 'running')
  assert.ok(running?.startedAt)
  const failed = updateLocalDeliveryAgentStep(steps, 'platform', 'failed', '连接超时')
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.log, '连接超时')
  assert.ok(failed?.finishedAt)
})

test('平台请求遇到瞬时连接失败会重试并返回成功结果', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  const retries: string[] = []
  globalThis.fetch = (async () => {
    calls += 1
    if (calls < 3) {
      throw new TypeError('fetch failed', {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await fetchJsonWithRetry<{ ok: boolean }>('http://example.test/health', {
      attempts: 3,
      timeoutMs: 1_000,
      onRetry: ({ error }) => retries.push(error),
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 3)
    assert.equal(retries.length, 2)
    assert.match(retries[0], /UND_ERR_CONNECT_TIMEOUT/)
    assert.match(describeFetchError(new TypeError('fetch failed', {
      cause: { code: 'ECONNRESET' },
    })), /ECONNRESET/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
