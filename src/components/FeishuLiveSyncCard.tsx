import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Laptop,
  LoaderCircle,
  LogIn,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  WifiOff,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import {
  discoverLocalFeishuAgentClientId,
  rememberLocalFeishuAgentClientId,
} from '../localAgentDiscovery'
import { useData } from '../store'
import type { FeishuAgentPairingSummary, Repository } from '../types'
import { StatusBadge } from './ui'

type BusyAction = 'refresh' | 'path' | 'pairing' | 'login' | 'sync' | 'rotate' | null

function isBasicComponentRepository(repository: Repository): boolean {
  return repository.name.trim().toLowerCase() === 'basic-component-cloud' ||
    repository.url.toLowerCase().includes('/basic-component-cloud')
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function resolveInstallerUrls(): { platformBaseUrl: string; downloadBaseUrl: string } {
  const browserOrigin = window.location.origin
  const apiBase = import.meta.env.VITE_API_BASE?.trim() ?? ''
  const proxyTarget = import.meta.env.DEV
    ? import.meta.env.VITE_API_PROXY_TARGET?.trim() ?? ''
    : ''
  const defaultDevApiUrl = window.location.protocol === 'https:'
    ? 'https://127.0.0.1:8787'
    : 'http://localhost:8787'
  const platformCandidate = /^https?:\/\//i.test(apiBase)
    ? apiBase
    : proxyTarget || (import.meta.env.DEV ? defaultDevApiUrl : browserOrigin)
  try {
    return {
      platformBaseUrl: new URL(platformCandidate).origin,
      downloadBaseUrl: browserOrigin,
    }
  } catch {
    return { platformBaseUrl: browserOrigin, downloadBaseUrl: browserOrigin }
  }
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
    refreshFeishuSyncToken,
    saveFeishuAgentRepoPaths,
    selectFeishuAgentClient,
    beginFeishuAgentLogin,
    syncFeishuAgent,
    rotateFeishuSyncToken,
    notify,
  } = useData()
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [pairings, setPairings] = useState<FeishuAgentPairingSummary[]>([])
  const [pairingPanelOpen, setPairingPanelOpen] = useState(false)
  const [pairingBusyClientId, setPairingBusyClientId] = useState('')
  const [pairingsRefreshing, setPairingsRefreshing] = useState(false)

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
  const { platformBaseUrl, downloadBaseUrl } = resolveInstallerUrls()
  const installerUrl = `${downloadBaseUrl}/downloads/install-orbit-agent-macos.sh`
  const installCommand =
    `curl --fail --silent --show-error --location ${shellQuote(installerUrl)} ` +
    `--output /tmp/install-orbit-agent-macos.sh && ` +
    `/bin/bash /tmp/install-orbit-agent-macos.sh ${shellQuote(platformBaseUrl)} ${shellQuote(downloadBaseUrl)}`
  const meegleInstallCommand =
    'npm install -g @lark-project/meegle@1.0.27 && meegle config set host project.feishu.cn'
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
      : '当前 Mac 尚未登记代理'
    : ready
      ? '自动同步就绪'
      : !feishuAgent.online
        ? '同步代理离线'
        : !agentConfigured
          ? '等待绑定密钥'
          : '等待飞书授权'

  useEffect(() => {
    if (!basicComponentRepository) return
    setRepoPath(configuredRepoPath || '')
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

  const refreshPairings = async () => {
    setPairingsRefreshing(true)
    try {
      setPairings(await api.getFeishuAgentPairings())
    } finally {
      setPairingsRefreshing(false)
    }
  }

  useEffect(() => {
    if (!pairingPanelOpen) return
    const timer = window.setInterval(() => {
      void api.getFeishuAgentPairings().then(setPairings).catch(() => undefined)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [pairingPanelOpen])

  const togglePairingPanel = () => {
    const opening = !pairingPanelOpen
    setPairingPanelOpen(opening)
    if (opening) {
      void run('pairing', refreshPairings)
    }
  }

  const approvePairingRequest = async (pairing: FeishuAgentPairingSummary) => {
    const path = basicComponentRepository ? repoPath.trim() : ''
    if (path && !path.startsWith('/')) throw new Error('本机仓库路径必须是绝对路径')
    const repoPaths = path && basicComponentRepository
      ? { [basicComponentRepository.id]: path }
      : {}
    if (!window.confirm(
      `确认绑定当前客户端？\n\n设备：${pairing.machineName}（${pairing.clientName}）\n校验码：${pairing.verificationCode}\n\n平台会将专属密钥加密发送给此客户端。`,
    )) return

    setPairingBusyClientId(pairing.clientId)
    try {
      await api.approveFeishuAgentPairing(pairing.clientId, repoPaths)
      rememberLocalFeishuAgentClientId(pairing.clientId)
      await selectFeishuAgentClient(pairing.clientId)
      await refreshPairings()
      notify(
        '客户端绑定已批准',
        `${pairing.machineName} 正在领取本机配置，完成后会出现在执行客户端列表中`,
        'info',
      )
    } finally {
      setPairingBusyClientId('')
    }
  }

  const approvePairing = (pairing: FeishuAgentPairingSummary) =>
    run('pairing', () => approvePairingRequest(pairing))

  const bindCurrentMac = () =>
    run('pairing', async () => {
      const clientId = await discoverLocalFeishuAgentClientId(true)
      if (!clientId) {
        setPairingPanelOpen(true)
        await refreshPairings()
        throw new Error('无法读取当前 Mac 代理的登记信息。若 18787 已被占用但健康检查无响应，请先恢复现有代理，再重试绑定。')
      }

      const existingClient = feishuAgentClients.find((client) => client.clientId === clientId)
      if (existingClient) {
        rememberLocalFeishuAgentClientId(clientId)
        await selectFeishuAgentClient(clientId)
        notify('当前 Mac 已登记', `${existingClient.clientName} 已加入执行客户端列表`)
        return
      }

      const currentPairings = await api.getFeishuAgentPairings()
      setPairings(currentPairings)
      setPairingPanelOpen(true)
      const pairing = currentPairings.find((item) => item.clientId === clientId)
      if (!pairing) {
        throw new Error('已检测到当前 Mac 代理，但绑定申请还未到达平台。请稍等几秒后重试。')
      }
      if (pairing.status === 'approved') {
        rememberLocalFeishuAgentClientId(clientId)
        await selectFeishuAgentClient(clientId)
        notify('绑定申请已批准', '当前 Mac 正在领取客户端配置')
        return
      }
      await approvePairingRequest(pairing)
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
                {client.clientId === localFeishuAgentClientId ? '（当前 Mac）' : ''}
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
                  ? `${selectedClient.clientName}${selectedClient.clientId === localFeishuAgentClientId ? '（当前 Mac）' : ''}${selectedClient.machineName && selectedClient.machineName !== selectedClient.clientName ? ` (${selectedClient.machineName})` : ''}`
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
          <small>全局同步凭据</small>
          <strong className={feishuSyncToken.configured ? 'is-ok' : 'is-warn'}>
            {feishuSyncToken.configured
              ? `${feishuSyncToken.hint ?? '已配置'} · ${feishuSyncToken.source === 'env' ? '服务器环境变量' : '平台生成'}`
              : '未配置（客户端可使用独立凭据）'}
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
              {localFeishuAgentClientId
                ? '已检测到当前 Mac 上的代理。点击“绑定当前 Mac”完成登记。'
                : feishuAgent.lastSeenAt
                ? `最近心跳：${formatRunTime(feishuAgent.lastSeenAt)}。请确认 launchd 服务仍在运行，恢复后页面会自动上线。`
                : '代理能响应时，点击“绑定当前 Mac”即可登记。首次安装才运行安装命令；若 18787 已占用，请先恢复现有代理。'}
            </p>
          </div>
          {!localFeishuAgentClientId && (
            <div className="feishu-live-offline-actions">
              <a className="btn btn-secondary btn-xs" href={installerUrl} download>
                下载 Mac 安装脚本
              </a>
              <button className="btn btn-secondary btn-xs" onClick={() => void copy(installCommand, '安装命令已复制')}>
                <Clipboard size={12} /> 复制安装命令
              </button>
            </div>
          )}
        </div>
      )}

      {localClientSelected && feishuAgent.online && basicComponentRepository && (
        <div className="feishu-local-repo-path">
          <label>
            <span>basic-component-cloud 本机仓库路径</span>
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="/Users/用户名/.../basic-component-cloud"
              aria-label="basic-component-cloud 本机仓库路径"
            />
          </label>
          <small>
            {basicComponentRepository
              ? `仓库标识：${basicComponentRepository.id}。填写后优先使用该 Mac 路径；留空时代理会按 Git 地址查找常用工作区，找不到再回退服务器临时检出。路径只写入当前 Mac 的代理。`
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

      {pairingPanelOpen && (
        <div className="feishu-agent-pairing-panel">
          <div className="feishu-agent-pairing-head">
            <div>
              <strong>添加执行客户端</strong>
              <p>本机代理主动向平台申请绑定，浏览器无需访问 Mac 的本地端口。</p>
            </div>
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => void run('pairing', refreshPairings)}
              disabled={pairingsRefreshing || busy !== null}
            >
              <RefreshCw size={13} className={pairingsRefreshing ? 'spin' : ''} />
              刷新申请
            </button>
          </div>

          {basicComponentRepository ? (
            <label className="feishu-agent-pairing-path">
              <span>本机仓库路径（可选）</span>
              <input
                value={repoPath}
                onChange={(event) => setRepoPath(event.target.value)}
                placeholder="留空则自动查找 Mac 上已有仓库"
                aria-label="待绑定客户端的 basic-component-cloud 本机路径"
              />
              <small>
                登记后优先使用该 Mac 路径；留空时先自动查找已有工作区，找不到再由服务器临时检出。
              </small>
            </label>
          ) : (
            <div className="feishu-agent-pairing-empty">
              先绑定客户端，之后可在“代码仓库”添加 basic-component-cloud。
            </div>
          )}

          {pairings.length === 0 ? (
            <div className="feishu-agent-pairing-empty">
              尚无待绑定申请。已运行的 Mac 代理会自动申请；点击“绑定当前 Mac”后可确认设备和校验码。
            </div>
          ) : (
            <div className="feishu-agent-pairing-list">
              {pairings.map((pairing) => (
                <div className="feishu-agent-pairing-row" key={pairing.clientId}>
                  <div>
                    <strong>{pairing.clientName}</strong>
                    <span>{pairing.machineName} · ID {pairing.clientId.slice(0, 8)}</span>
                    <small>校验码 {pairing.verificationCode} · 到期 {formatRunTime(pairing.expiresAt)}</small>
                  </div>
                  {pairing.status === 'approved' ? (
                    <span className="feishu-agent-pairing-approved">等待客户端接入</span>
                  ) : (
                    <button
                      className="btn btn-primary btn-xs"
                      onClick={() => void approvePairing(pairing)}
                      disabled={busy !== null}
                    >
                      {pairingBusyClientId === pairing.clientId
                        ? <LoaderCircle size={13} className="spin" />
                        : <CheckCircle2 size={13} />}
                      批准并绑定
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <small className="feishu-agent-pairing-security">
            批准前请确认机器名和校验码与本机代理输出一致；同步密钥只会加密后发给申请它的客户端。
          </small>
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
            当前选择的执行客户端不在这台 Mac 上。点击“绑定当前 Mac”可加入已运行的本机代理；需要登录后自动运行时，再安装自启动服务。
          </span>
        </div>
      )}

      {lastRunFailed && lastRun?.error && (
        <div className="feishu-live-warning">
          <AlertTriangle size={15} />
          <span>{lastRun.error}</span>
        </div>
      )}

      {feishuAgent.online && agentConfigured && health?.meegle.available === false && (
        <div className="feishu-live-warning">
          <AlertTriangle size={15} />
          <span>当前 Mac 未安装 Meegle CLI。安装并配置后，点击“重新检测”再开始飞书授权。</span>
          <button
            className="btn btn-secondary btn-xs"
            onClick={() => void copy(meegleInstallCommand, 'Meegle CLI 安装命令已复制')}
          >
            <Clipboard size={12} /> 复制安装命令
          </button>
        </div>
      )}

      <div className="feishu-live-actions">
        <button className="btn btn-secondary" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw size={14} className={busy === 'refresh' || feishuAgent.checking ? 'spin' : ''} />
          重新检测
        </button>
        {!localClientSelected && (
          <button className="btn btn-primary" onClick={() => void bindCurrentMac()} disabled={busy !== null}>
            {busy === 'pairing' ? <LoaderCircle size={14} className="spin" /> : <Laptop size={14} />}
            绑定当前 Mac
          </button>
        )}
        <button className="btn btn-secondary" onClick={togglePairingPanel} disabled={busy !== null}>
          <Plus size={14} /> {pairingPanelOpen ? '收起客户端登记' : '添加其他客户端'}
        </button>
        {feishuAgent.online && agentConfigured && health?.meegle.available && !meegleAuthenticated && (
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
        {agentConfigured && feishuSyncToken.source !== 'env' && (
          <button className="btn btn-secondary" onClick={() => void rotate()} disabled={busy !== null}>
            <RotateCcw size={14} /> 轮换密钥
          </button>
        )}
        {ready && (
          <span className="feishu-live-ready">
            <CheckCircle2 size={14} /> 每 60 秒检查代理，距上次同步超过 10 分钟自动更新
          </span>
        )}
      </div>
    </article>
  )
}
