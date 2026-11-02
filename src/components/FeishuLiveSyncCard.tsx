import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  KeyRound,
  Laptop,
  LoaderCircle,
  LogIn,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Terminal,
  WifiOff,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useData } from '../store'
import type { Repository } from '../types'
import { StatusBadge } from './ui'

type BusyAction = 'refresh' | 'bind' | 'path' | 'login' | 'sync' | 'rotate' | null

const BASIC_COMPONENT_LOCAL_PATH =
  '/Users/shinya/Documents/workspace/SME/basic-component-cloud'

function isBasicComponentRepository(repository: Repository): boolean {
  return repository.name.trim().toLowerCase() === 'basic-component-cloud' ||
    repository.url.toLowerCase().includes('/basic-component-cloud')
}

function formatRunTime(value: string | undefined): string {
  if (!value) return '尚未同步'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

export function FeishuLiveSyncCard() {
  const {
    repositories,
    feishuAgent,
    feishuAgentClients,
    selectedFeishuAgentClientId,
    localFeishuAgentClientId,
    feishuAgentLogin,
    feishuSyncToken,
    refreshFeishuAgent,
    selectFeishuAgentClient,
    refreshFeishuSyncToken,
    bindFeishuAgent,
    saveFeishuAgentRepoPaths,
    beginFeishuAgentLogin,
    syncFeishuAgent,
    rotateFeishuSyncToken,
    notify,
  } = useData()
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState('')
  const [issuedToken, setIssuedToken] = useState('')
  const [repoPath, setRepoPath] = useState('')

  const health = feishuAgent.health
  const agentConfigured = Boolean(health?.config.configured)
  const meegleAuthenticated = Boolean(health?.meegle.authenticated)
  const feishuMcp = health?.feishuMcp
  const meegleMcp = health?.meegleMcp
  const selectedClient = feishuAgentClients.find(
    (client) => client.clientId === selectedFeishuAgentClientId,
  )
  const basicComponentRepository = repositories.find(isBasicComponentRepository)
  const configuredRepoPath = basicComponentRepository
    ? selectedClient?.health?.config.repoPaths?.[basicComponentRepository.id]
    : undefined
  const localClientSelected = Boolean(
    localFeishuAgentClientId && selectedFeishuAgentClientId === localFeishuAgentClientId,
  )
  const ready = feishuAgent.online && agentConfigured && meegleAuthenticated
  const command = 'npm run feishu:agent'
  const lastRun = health?.lastRun
  const lastRunFailed = lastRun?.status === 'failed'
  const status = selectedFeishuAgentClientId && ready
    ? 'active'
    : selectedFeishuAgentClientId && feishuAgent.online && agentConfigured
      ? 'pending'
      : 'warning'
  const statusLabel = !selectedFeishuAgentClientId
    ? localFeishuAgentClientId
      ? '未选择执行客户端'
      : '当前终端未注册代理'
    : ready
      ? '自动同步就绪'
      : !feishuAgent.online
        ? '同步代理离线'
        : !agentConfigured
          ? '等待绑定密钥'
          : '等待飞书授权'

  useEffect(() => {
    if (!basicComponentRepository) return
    setRepoPath(
      configuredRepoPath ||
        basicComponentRepository.localPath ||
        BASIC_COMPONENT_LOCAL_PATH,
    )
  }, [basicComponentRepository?.id, basicComponentRepository?.localPath, configuredRepoPath])

  const run = async (action: BusyAction, operation: () => Promise<unknown>) => {
    setBusy(action)
    setError('')
    try {
      await operation()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '操作失败，请稍后重试')
    } finally {
      setBusy(null)
    }
  }

  const copy = async (value: string, title: string) => {
    try {
      await navigator.clipboard.writeText(value)
      notify(title, '已复制到剪贴板', 'success')
    } catch {
      notify('复制失败', '浏览器未授予剪贴板权限，请手动选择内容', 'warning')
    }
  }

  const refresh = () =>
    run('refresh', async () => {
      await Promise.all([refreshFeishuAgent(), refreshFeishuSyncToken()])
    })

  const bind = () =>
    run('bind', async () => {
      if (!basicComponentRepository) {
        throw new Error('平台仓库列表中找不到 basic-component-cloud')
      }
      const path = repoPath.trim()
      if (!path.startsWith('/')) throw new Error('本机仓库路径必须是绝对路径')
      const result = await bindFeishuAgent({
        repoPaths: { [basicComponentRepository.id]: path },
        syncToken: issuedToken || undefined,
      })
      if (result.token) setIssuedToken(result.token)
      if (result.error) throw new Error(result.error)
      setIssuedToken('')
      notify('本机代理已绑定', '平台密钥和 basic-component-cloud 本机路径已写入代理配置')
    })

  const saveRepoPath = () =>
    run('path', async () => {
      if (!basicComponentRepository) {
        throw new Error('平台仓库列表中找不到 basic-component-cloud')
      }
      const path = repoPath.trim()
      if (!path.startsWith('/')) throw new Error('本机仓库路径必须是绝对路径')
      await saveFeishuAgentRepoPaths({ [basicComponentRepository.id]: path })
      await refreshFeishuAgent(true)
      notify('本机仓库路径已保存', path)
    })

  const login = () => run('login', async () => beginFeishuAgentLogin())
  const sync = () => run('sync', () => syncFeishuAgent(true))
  const rotate = () =>
    run('rotate', async () => {
      if (!window.confirm('确认轮换平台同步密钥？旧密钥会立即失效。')) return
      await rotateFeishuSyncToken()
      setIssuedToken('')
    })

  return (
    <article className="card feishu-live-card">
      <div className="feishu-live-head">
        <div className="feishu-live-title">
          <span className="feishu-live-icon"><Laptop size={17} /></span>
          <div>
            <h2>飞书实时同步</h2>
            <p>可从任意页面选择在线执行客户端；代理通过平台心跳领取自己的任务，从已登录的 Meegle CLI 拉取需求和缺陷并写入平台。</p>
          </div>
        </div>
        <StatusBadge status={status} label={statusLabel} />
      </div>

      {feishuAgentClients.length > 0 && (
        <label className="feishu-agent-client-picker">
          <span>执行客户端</span>
          <select
            value={selectedFeishuAgentClientId ?? ''}
            onChange={(event) => void selectFeishuAgentClient(event.target.value)}
            aria-label="选择飞书同步执行客户端"
          >
            {!selectedFeishuAgentClientId && <option value="">请选择执行客户端</option>}
            {feishuAgentClients.map((client) => (
              <option key={client.clientId} value={client.clientId}>
                {client.clientName}
                {client.clientId === localFeishuAgentClientId ? '（当前终端）' : ''}
                {client.machineName && client.machineName !== client.clientName
                  ? ` · ${client.machineName}`
                  : ''}{' '}
                · {client.online ? '在线' : '离线'} ·{' '}
                {client.clientId.slice(0, 8)}
              </option>
            ))}
          </select>
          <small>
            {!selectedClient
              ? '请选择要执行同步的机器；平台不会自动选择'
              : selectedClient.health?.config.repoPaths
              ? `仓库路径：${Object.entries(selectedClient.health.config.repoPaths)
                  .map(([repoId, path]) => `${repoId} → ${path}`)
                  .join('；')}`
              : '该客户端未上报仓库专属路径，将使用平台共享路径'}
          </small>
        </label>
      )}

      <div className="feishu-live-meta">
        <span>
          <small>执行客户端</small>
          <strong className={feishuAgent.online ? 'is-ok' : 'is-warn'}>
            {feishuAgent.checking
              ? '检测中…'
              : feishuAgent.online
                ? selectedClient
                  ? `${selectedClient.clientName}${selectedClient.clientId === localFeishuAgentClientId ? '（当前终端）' : ''}${selectedClient.machineName && selectedClient.machineName !== selectedClient.clientName ? ` (${selectedClient.machineName})` : ''}`
                  : '未选择'
                : selectedClient?.clientName || '未选择'}
          </strong>
        </span>
        <span>
          <small>Meegle 登录</small>
          <strong className={meegleAuthenticated ? 'is-ok' : 'is-warn'}>
            {!health?.meegle.available
              ? '未安装'
              : meegleAuthenticated
                ? '已授权'
                : '等待授权'}
          </strong>
        </span>
        <span>
          <small>飞书 MCP</small>
          <strong className={feishuMcp?.available ? 'is-ok' : 'is-warn'} title={feishuMcp?.reason}>
            {!feishuMcp?.enabled
              ? '已禁用'
              : !feishuMcp.configured
                ? '未配置'
                : !feishuMcp.available
                  ? '缺少 lark-mcp'
                  : feishuMcp.authenticated
                    ? '已授权'
                    : '已配置'}
          </strong>
        </span>
        <span>
          <small>Meegle MCP</small>
          <strong className={meegleMcp?.available ? 'is-ok' : 'is-warn'} title={meegleMcp?.reason}>
            {!meegleMcp?.enabled
              ? '已禁用'
              : !meegleMcp.configured
                ? '未配置'
                : !meegleMcp.available
                  ? '缺少 CLI'
                  : meegleAuthenticated
                    ? '已就绪'
                    : '已配置'}
          </strong>
        </span>
        <span>
          <small>平台同步密钥</small>
          <strong className={feishuSyncToken.configured ? 'is-ok' : 'is-warn'}>
            {feishuSyncToken.configured
              ? `${feishuSyncToken.hint ?? '已配置'} · ${feishuSyncToken.source === 'env' ? '服务器环境变量' : '平台生成'}`
              : '尚未生成'}
          </strong>
        </span>
        <span>
          <small>代理绑定</small>
          <strong className={agentConfigured ? 'is-ok' : 'is-warn'}>
            {agentConfigured ? health?.config.platformBaseUrl : '未绑定'}
          </strong>
        </span>
        <span>
          <small>最近同步</small>
          <strong className={lastRunFailed ? 'is-warn' : ''}>
            {lastRun ? formatRunTime(lastRun.at) : '尚未同步'}
          </strong>
        </span>
      </div>

      <div className="feishu-live-note">
        <ShieldCheck size={15} />
        <span>
          飞书登录态只保存在本机。Meegle MCP 提供实时需求/缺陷查询，飞书 MCP 提供文档/Wiki/IM 能力；页面只读取平台中转的脱敏状态。
        </span>
        <code>平台中转 · 90 秒心跳</code>
      </div>

      {!feishuAgent.online && !feishuAgent.checking && (
        <div className="feishu-live-offline">
          <WifiOff size={16} />
          <div>
            <strong>{feishuAgent.lastSeenAt ? '同步代理暂时离线' : '尚未收到同步代理心跳'}</strong>
            <p>
              {feishuAgent.lastSeenAt
                ? `最近心跳：${formatRunTime(feishuAgent.lastSeenAt)}。请确认 launchd 服务仍在运行，恢复后页面会自动上线。`
                : '在已登录飞书的电脑上启动代理，保持服务运行后会通过平台心跳自动上线。'}
            </p>
          </div>
          <code>{command}</code>
          <button className="btn btn-secondary btn-xs" onClick={() => void copy(command, '启动命令已复制')}>
            <Clipboard size={12} /> 复制
          </button>
        </div>
      )}

      {feishuAgent.online && !agentConfigured && feishuSyncToken.source === 'env' && (
        <div className="feishu-live-warning">
          <AlertTriangle size={15} />
          <span>
            服务器使用环境变量管理密钥。请让服务器管理员提供该值，并在本机启动代理时设置
            <code> PLATFORM_SYNC_TOKEN </code>，或在服务器改用页面生成的数据库密钥。
          </span>
        </div>
      )}

      {localClientSelected && feishuAgent.online && (
        <div className="feishu-local-repo-path">
          <label>
            <span>basic-component-cloud 本机仓库路径</span>
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="/Users/用户名/Documents/workspace/SME/basic-component-cloud"
              aria-label="basic-component-cloud 本机仓库路径"
            />
          </label>
          <small>
            {basicComponentRepository
              ? `仓库标识：${basicComponentRepository.id}。路径只写入当前 Mac 的代理。`
              : '平台仓库列表中找不到 basic-component-cloud。'}
          </small>
          {agentConfigured && (
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => void saveRepoPath()}
              disabled={busy !== null || !basicComponentRepository}
            >
              {busy === 'path' ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}
              保存本机路径
            </button>
          )}
        </div>
      )}

      {feishuAgentLogin.challenge && (
        <div className="feishu-login-challenge">
          <div>
            <strong><LogIn size={15} /> 完成飞书设备授权</strong>
            <p>在浏览器打开授权链接，确认后输入下方用户码。页面会自动轮询并触发首次同步。</p>
          </div>
          <div className="feishu-login-code">
            <a href={feishuAgentLogin.challenge.verificationUriComplete} target="_blank" rel="noreferrer">
              打开飞书授权 <ExternalLink size={12} />
            </a>
            <code>{feishuAgentLogin.challenge.userCode}</code>
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => void copy(feishuAgentLogin.challenge?.userCode ?? '', '用户码已复制')}
            >
              <Clipboard size={12} /> 复制用户码
            </button>
          </div>
          <small className={feishuAgentLogin.error ? 'is-error' : ''}>
            {feishuAgentLogin.error
              ? feishuAgentLogin.error
              : feishuAgentLogin.polling
                ? '正在等待飞书授权完成…'
                : '授权完成后会自动同步'}
          </small>
        </div>
      )}

      {issuedToken && (
        <div className="feishu-token-once">
          <div>
            <strong><KeyRound size={15} /> 一次性平台同步密钥</strong>
            <p>仅在本机代理绑定失败时使用。关闭页面后不会再次显示，请勿写入仓库或聊天记录。</p>
          </div>
          <code>{issuedToken}</code>
          <button className="btn btn-secondary btn-xs" onClick={() => void copy(issuedToken, '同步密钥已复制')}>
            <Clipboard size={12} /> 复制密钥
          </button>
        </div>
      )}

      {error && (
        <div className="feishu-live-warning">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {!localFeishuAgentClientId && feishuAgentClients.length > 0 && (
        <div className="feishu-live-warning">
          <AlertTriangle size={15} />
          <span>
            当前页面所在终端未检测到执行代理；下方客户端属于其他机器。请先在本机项目目录运行
            <code> npm run feishu:agent</code>，否则任务不会在页面所在机器执行。
          </span>
        </div>
      )}

      {lastRunFailed && lastRun?.error && (
        <div className="feishu-live-warning">
          <AlertTriangle size={15} />
          <span>{lastRun.error}</span>
        </div>
      )}

      <div className="feishu-live-actions">
        <button className="btn btn-secondary" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw size={14} className={busy === 'refresh' || feishuAgent.checking ? 'spin' : ''} />
          重新检测
        </button>
        {feishuAgent.online && localClientSelected && !agentConfigured &&
          (feishuSyncToken.source === 'none' || Boolean(issuedToken)) && (
          <button className="btn btn-primary" onClick={() => void bind()} disabled={busy !== null}>
            {busy === 'bind' ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}
            {issuedToken ? '重试本机绑定' : '生成密钥并绑定'}
          </button>
        )}
        {feishuAgent.online && localClientSelected && !agentConfigured &&
          feishuSyncToken.source === 'database' && !issuedToken && (
          <span className="feishu-live-ready is-warn">
            平台已有密钥，需从原代理轮换后才能绑定这台 Mac
          </span>
        )}
        {feishuAgent.online && agentConfigured && !meegleAuthenticated && (
          <button className="btn btn-primary" onClick={() => void login()} disabled={busy !== null}>
            {busy === 'login' ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />}
            开始飞书授权
          </button>
        )}
        {ready && (
          <button className="btn btn-primary" onClick={() => void sync()} disabled={busy !== null}>
            {busy === 'sync' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            立即同步
          </button>
        )}
        {agentConfigured && feishuSyncToken.source === 'database' && (
          <button className="btn btn-secondary" onClick={() => void rotate()} disabled={busy !== null}>
            <RotateCcw size={14} /> 轮换密钥
          </button>
        )}
        {ready && (
          <span className="feishu-live-ready">
            <CheckCircle2 size={14} /> 每 60 秒检查代理，距上次同步超过 10 分钟自动更新
          </span>
        )}
        {!feishuAgent.online && (
          <span className="feishu-live-command"><Terminal size={14} /> {command}</span>
        )}
      </div>
    </article>
  )
}
