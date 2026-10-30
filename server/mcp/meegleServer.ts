import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { pathToFileURL } from 'node:url'
import {
  getMeegleAuthStatus,
  getMeegleWorkItem,
  queryMeegleWorkItems,
  searchMeegleProjects,
  type MeegleCommandRunner,
  type MeegleSyncConfig,
} from '../services/meegleCliClient.js'

export interface CreateMeegleMcpServerOptions {
  config?: Partial<MeegleSyncConfig>
  runner?: MeegleCommandRunner
}

function baseConfig(overrides: Partial<MeegleSyncConfig> = {}): MeegleSyncConfig {
  return {
    command: process.env.MEEGLE_BIN?.trim() || 'meegle',
    host: process.env.MEEGLE_HOST?.trim() || 'project.feishu.cn',
    projectKey: process.env.FEISHU_PROJECT_KEY?.trim() || 'rjcloud',
    requirementTypeKey: process.env.FEISHU_REQUIREMENT_TYPE_KEY?.trim() || 'story',
    defectTypeKey: process.env.FEISHU_DEFECT_TYPE_KEY?.trim() || 'issue',
    requirementProjectField:
      process.env.FEISHU_REQUIREMENT_PROJECT_FIELD?.trim() || 'field_c7834f',
    defectProjectField: process.env.FEISHU_DEFECT_PROJECT_FIELD?.trim() || 'field_e1d325',
    defaultOwner: process.env.FEISHU_DEFAULT_OWNER?.trim() || '飞书同步',
    fetchDescriptions: false,
    ...overrides,
  }
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: error instanceof Error ? error.message : String(error),
    }],
  }
}

export function createMeegleMcpServer(options: CreateMeegleMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'orbit-meegle',
    version: '1.0.0',
  })
  const config = baseConfig(options.config)
  const runner = options.runner

  server.registerTool('meegle_list_work_items', {
    description:
      'Query live Meegle/Lark Project requirements or defects with title search, status, owner and date filters. Read-only.',
    inputSchema: {
      projectKey: z.string().min(1).max(200).optional().describe('Meegle project key, default rjcloud'),
      type: z.enum(['requirement', 'defect', 'all']).optional().describe('Work item type'),
      search: z.string().max(200).optional().describe('Case-insensitive title fragment'),
      status: z.string().max(200).optional().describe('Exact Meegle status label, e.g. 规划中'),
      owner: z.string().max(200).optional().describe('Exact current owner name'),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only items updated since YYYY-MM-DD'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum items, default 50'),
    },
  }, async ({ projectKey, ...query }) => {
    try {
      const result = await queryMeegleWorkItems(
        baseConfig({ ...config, ...(projectKey ? { projectKey } : {}) }),
        query,
        runner,
      )
      return jsonResult({ projectKey: projectKey || config.projectKey, ...result })
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('meegle_get_work_item', {
    description: 'Read one live Meegle/Lark Project work item by numeric work item ID. Read-only.',
    inputSchema: {
      workItemId: z.string().min(1).max(128).describe('Meegle work item ID'),
      projectKey: z.string().min(1).max(200).optional().describe('Meegle project key, default rjcloud'),
    },
  }, async ({ workItemId, projectKey }) => {
    try {
      const payload = await getMeegleWorkItem(
        baseConfig({ ...config, ...(projectKey ? { projectKey } : {}) }),
        workItemId,
        runner,
      )
      return jsonResult(payload)
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('meegle_search_projects', {
    description: 'Search Meegle/Lark Project spaces or list recently visited spaces. Read-only.',
    inputSchema: {
      projectKey: z.string().max(200).optional().describe('Project key, simple name or space name'),
    },
  }, async ({ projectKey }) => {
    try {
      return jsonResult(await searchMeegleProjects(config, projectKey, runner))
    } catch (error) {
      return errorResult(error)
    }
  })

  server.registerTool('meegle_auth_status', {
    description: 'Check whether the local Meegle CLI is authenticated. Read-only and returns no token.',
    inputSchema: {},
  }, async () => {
    try {
      return jsonResult(await getMeegleAuthStatus(config, runner))
    } catch (error) {
      return errorResult(error)
    }
  })

  return server
}

async function main(): Promise<void> {
  const server = createMeegleMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Orbit Meegle MCP server ready on stdio')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('Orbit Meegle MCP server failed:', error)
    process.exit(1)
  })
}
