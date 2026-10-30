import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { getMeegleAuthStatus, type MeegleSyncConfig } from '../services/meegleCliClient.js'
import { resolveMeegleMcpRuntime } from '../services/meegleMcpService.js'

function meegleConfig(): MeegleSyncConfig {
  return {
    command: process.env.MEEGLE_BIN?.trim() || 'meegle',
    host: process.env.MEEGLE_HOST?.trim() || 'project.feishu.cn',
    projectKey: process.env.FEISHU_PROJECT_KEY?.trim() || 'rjcloud',
    requirementTypeKey: process.env.FEISHU_REQUIREMENT_TYPE_KEY?.trim() || 'story',
    defectTypeKey: process.env.FEISHU_DEFECT_TYPE_KEY?.trim() || 'issue',
    requirementProjectField: process.env.FEISHU_REQUIREMENT_PROJECT_FIELD?.trim() || 'field_c7834f',
    defectProjectField: process.env.FEISHU_DEFECT_PROJECT_FIELD?.trim() || 'field_e1d325',
    defaultOwner: process.env.FEISHU_DEFAULT_OWNER?.trim() || '飞书同步',
    fetchDescriptions: false,
  }
}

async function status(): Promise<void> {
  const runtime = resolveMeegleMcpRuntime()
  let auth: Awaited<ReturnType<typeof getMeegleAuthStatus>> | undefined
  let authError: string | undefined
  if (runtime.status.available) {
    try {
      auth = await getMeegleAuthStatus(meegleConfig())
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error)
    }
  }
  console.log(JSON.stringify({
    ...runtime.status,
    authenticated: auth?.authenticated ?? false,
    host: auth?.host,
    reason: runtime.status.reason ?? auth?.reason ?? authError,
  }, null, 2))
}

function main(): void {
  const action = process.argv[2]?.trim() || 'status'
  if (action === 'help' || action === '--help' || action === '-h') {
    console.log('Usage: npm run mcp:meegle:status | npm run mcp:meegle')
    return
  }
  if (action === 'status') {
    void status().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
    return
  }
  if (action === 'start') {
    const runtime = resolveMeegleMcpRuntime()
    if (!runtime.command || !runtime.status.available) {
      throw new Error(runtime.status.reason ?? 'Meegle MCP 不可用')
    }
    const result = spawnSync(runtime.command, runtime.args, { stdio: 'inherit', env: process.env })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
    return
  }
  throw new Error(`未知命令：${action}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
