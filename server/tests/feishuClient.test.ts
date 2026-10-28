import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { FeishuProjectClient } from '../services/feishuClient.js'

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function json(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

test('飞书项目客户端完成鉴权、同步、字段映射和关闭流转', async () => {
  const calls: Array<{ method: string; path: string; token?: string; userKey?: string; body: Record<string, unknown> }> = []
  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    calls.push({
      method: request.method ?? '',
      path: request.url ?? '',
      token: request.headers['x-plugin-token'] as string | undefined,
      userKey: request.headers['x-user-key'] as string | undefined,
      body,
    })

    if (request.url === '/open_api/authen/plugin_token') {
      assert.deepEqual(body, {
        plugin_id: 'plug-test',
        plugin_secret: 'secret-test',
        type: 0,
      })
      json(response, { data: { token: 'plugin-token', expire_time: 3600 } })
      return
    }
    if (request.url === '/open_api/projects/detail') {
      json(response, {
        data: { rjcloud: { project_key: 'rjcloud', name: 'RJ Cloud' } },
      })
      return
    }
    if (request.url === '/open_api/rjcloud/work_item/story/meta') {
      json(response, { data: { fields: [] } })
      return
    }
    if (request.url === '/open_api/rjcloud/work_item/issue/meta') {
      json(response, { data: { fields: [] } })
      return
    }
    if (request.url === '/open_api/rjcloud/work_item/filter') {
      const typeKey = Array.isArray(body.work_item_type_keys)
        ? String(body.work_item_type_keys[0])
        : ''
      if (typeKey === 'story') {
        json(response, { data: { work_items: [{ id: 101, name: '需求 A' }] } })
      } else {
        json(response, { data: { work_items: [{ id: 201, name: '缺陷 A' }] } })
      }
      return
    }
    if (request.url === '/open_api/rjcloud/work_item/story/query') {
      json(response, {
        data: {
          work_items: [
            {
              id: 101,
              name: '需求 A',
              description: '来自飞书的需求描述',
              priority: '高',
              owner: { user_key: 'alice' },
              updated_at: 1_700_000_000,
            },
          ],
        },
      })
      return
    }
    if (request.url === '/open_api/rjcloud/work_item/issue/query') {
      json(response, {
        data: {
          work_items: [
            {
              id: 201,
              name: '缺陷 A',
              fields: [
                { field_key: 'priority', field_value: '紧急' },
                { field_key: 'description', field_value: '来自飞书的缺陷描述' },
              ],
            },
          ],
        },
      })
      return
    }
    if (request.url === '/open_api/rjcloud/workflow/issue/201/node/state_change') {
      assert.deepEqual(body, { transition_id: 123456 })
      json(response, { data: {} })
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ err_msg: `unexpected path ${request.url}` }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const client = new FeishuProjectClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    projectKey: 'rjcloud',
    pluginId: 'plug-test',
    pluginSecret: 'secret-test',
    userKey: 'user-test',
  })

  try {
    const connection = await client.testConnection('story', 'issue')
    assert.equal(connection.projectName, 'RJ Cloud')

    const inbox = await client.fetchInboxItems('story', 'issue', '飞书同步')
    assert.equal(inbox.fetched, 2)
    assert.equal(inbox.skipped, 0)
    assert.deepEqual(
      inbox.items.map((item) => ({
        externalId: item.externalId,
        type: item.type,
        priority: item.priority,
        owner: item.owner,
      })),
      [
        {
          externalId: 'rjcloud:story:101',
          type: 'requirement',
          priority: '高',
          owner: 'alice',
        },
        {
          externalId: 'rjcloud:issue:201',
          type: 'defect',
          priority: '紧急',
          owner: '飞书同步',
        },
      ],
    )
    assert.equal(inbox.items[1].description, '来自飞书的缺陷描述')

    await client.closeWorkItem('rjcloud', 'issue', '201', '123456')

    const authorizedCalls = calls.filter((call) => !call.path.endsWith('/plugin_token'))
    assert.ok(authorizedCalls.length > 0)
    assert.equal(authorizedCalls.every((call) => call.token === 'plugin-token'), true)
    assert.equal(authorizedCalls.every((call) => call.userKey === 'user-test'), true)
    assert.equal(calls.filter((call) => call.path.endsWith('/plugin_token')).length, 1)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})
