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
  ShieldCheck,
  Terminal,
  WifiOff,
} from 'lucide-react'
import { useState } from 'react'
import { useData } from '../store'
import { StatusBadge } from './ui'

type BusyAction = 'refresh' | 'bind' | 'login' | 'sync' | 'rotate' | null

function formatRunTime(value: string | undefined): string {
  if (!value) return '尚未同步'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

export function FeishuLiveSyncCard() {
  const {
    feishuAgent,
    feishuAgentLogin,
    feishuSyncToken,
    refreshFeishuAgent,
    refreshFeishuSyncToken,
    bindFeishuAgent,
    beginFeishuAgentLogin,
    syncFeishuAgent,
    rotateFeishuSyncToken,
    notify,
  } = useData()
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState('')
  const [issuedToken, setIssuedToken] = useState('')

  const health = feishuAgent.health
  const agentConfigured = Boolean(health?.config.configured)
  const meegleAuthenticated = Boolean(health?.meegle.authenticated)
  const ready = feishuAgent.online && agentConfigured && meegleAuthenticated
  const command = 'npm run feishu:agent'
  const lastRun = health?.lastRun
  const lastRunFailed = lastRun?.status === 'failed'
  const status = ready
    ? 'active'
    : feishuAgent.online && agentConfigured
      ? 'pending'
      : 'warning'
  const statusLabel = ready
    ? '自动同步就绪'
    : !feishuAgent.online
      ? '同步代理离线'
      : !agentConfigured
        ? '等待绑定密钥'
        : '等待飞书授权'

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
      const result = await bindFeishuAgent()
      if (result.token) setIssuedToken(result.token)
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
            <h2>本机飞书实时同步</h2>
            <p>同步代理通过平台心跳接收任务，从已登录的 Meegle CLI 拉取需求和缺陷并写入平台。</p>
          </div>
        </div>
        <StatusBadge status={status} label={statusLabel} />
      </div>

      <div className="feishu-live-meta">
        <span>
          <small>本机代理</small>
          <strong className={feishuAgent.online ? 'is-ok' : 'is-warn'}>
            {feishuAgent.checking ? '检测中…' : feishuAgent.online ? '在线' : '离线'}
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
          飞书登录态只保存在本机 Meegle CLI。页面只读取平台中转的脱敏状态，不直接访问本机端口；无需手动获取或复制飞书 Cookie。
        </span>
        <code>平台中转 · 45 秒心跳</code>
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
        {feishuAgent.online && !agentConfigured && feishuSyncToken.source !== 'env' && (
          <button className="btn btn-primary" onClick={() => void bind()} disabled={busy !== null}>
            {busy === 'bind' ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}
            生成密钥并绑定
          </button>
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
