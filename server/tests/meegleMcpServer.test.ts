import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMeegleMcpServer } from '../mcp/meegleServer.js'
import type { MeegleCommandResult, MeegleCommandRunner } from '../services/meegleCliClient.js'

function result(payload: unknown): MeegleCommandResult {
  return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 }
}

test('Meegle MCP 暴露只读查询工具并返回实时工作项', async () => {
  const calls: string[][] = []
  const runner: MeegleCommandRunner = async (_command, args) => {
    calls.push(args)
    if (args[0] === 'auth') return result({ authenticated: true })
    if (args[0] === 'workitem' && args[1] === 'query') {
      return result({
        session_id: 'session-1',
        list: [{ count: 1, group_infos: [{ group_id: '1' }] }],
        data: {
          '1': [{
            moql_field_list: [
              { key: 'work_item_id', value: { long_value: 7141333577 } },
              { key: 'name', value: { string_value: 'MCP 实时需求' } },
              { key: 'work_item_status', value: { key_label_value_list: [{ label: '规划中' }] } },
              { key: 'description', value: { string_value: '来自实时 MQL 查询' } },
            ],
          }],
        },
      })
    }
    if (args[0] === 'workitem' && args[1] === 'get') {
      return result({ work_item_attribute: { work_item_id: '7141333577' } })
    }
    if (args[0] === 'project' && args[1] === 'search') {
      return result({ data: [{ project_key: 'rjcloud' }] })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const server = createMeegleMcpServer({
    config: {
      command: 'meegle',
      host: 'project.feishu.cn',
      projectKey: 'rjcloud',
      requirementTypeKey: 'story',
      defectTypeKey: 'issue',
      defaultOwner: '飞书同步',
      fetchDescriptions: false,
    },
    runner,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'orbit-test', version: '1.0.0' })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const tools = await client.listTools()
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        'meegle_auth_status',
        'meegle_get_work_item',
        'meegle_list_work_items',
        'meegle_search_projects',
      ],
    )

    const queried = await client.callTool({
      name: 'meegle_list_work_items',
      arguments: { type: 'requirement', search: 'MCP', limit: 5 },
    })
    assert.equal(queried.isError, undefined)
    const content = Array.isArray(queried.content) ? queried.content[0] : undefined
    assert.equal(content?.type, 'text')
    const text = content && content.type === 'text' ? content.text : ''
    const payload = JSON.parse(text) as { items?: Array<{ workItemId?: string; title?: string }> }
    assert.equal(payload.items?.[0]?.workItemId, '7141333577')
    assert.equal(payload.items?.[0]?.title, 'MCP 实时需求')

    const auth = await client.callTool({ name: 'meegle_auth_status', arguments: {} })
    const authContent = Array.isArray(auth.content) ? auth.content[0] : undefined
    assert.equal(
      authContent && authContent.type === 'text' ? JSON.parse(authContent.text).authenticated : false,
      true,
    )
    assert.equal(calls.some((args) => args[0] === 'auth'), true)
  } finally {
    await client.close()
    await server.close()
  }
})
