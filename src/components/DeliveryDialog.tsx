import {
  ArrowRight,
  CheckCircle2,
  Copy,
  FileText,
  FolderGit2,
  GitBranch,
  GitMerge,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useData } from '../store'
import type { PipelineRun } from '../types'
import { Field, Modal, StatusBadge } from './ui'

export function DeliveryDialog({
  open,
  onClose,
  onStarted,
  initialWorkItemId,
}: {
  open: boolean
  onClose: () => void
  onStarted: (run: PipelineRun) => void
  initialWorkItemId?: string
}) {
  const { workItems, repositories, startPipeline, notify } = useData()
  const [workItemId, setWorkItemId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [executionMode, setExecutionMode] = useState<'client' | 'server'>('client')
  const [autoCommit, setAutoCommit] = useState(true)
  const [pushAfterAcceptance, setPushAfterAcceptance] = useState(true)
  const [autoClose, setAutoClose] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [localCommand, setLocalCommand] = useState('')

  const availableItems = workItems.filter((item) => item.status !== '已关闭')
  const selectedItem = workItems.find((item) => item.id === workItemId)
  const selectedRepo = repositories.find((repo) => repo.id === repoId)

  useEffect(() => {
    if (!open) return
    const preferred = availableItems.find((item) => item.id === initialWorkItemId) ?? availableItems[0]
    setWorkItemId(preferred?.id ?? '')
    const preferredRepoId = preferred?.repoId ?? repositories[0]?.id ?? ''
    setRepoId(preferredRepoId)
    setExecutionMode(
      repositories.find((repo) => repo.id === preferredRepoId)?.localPath ? 'client' : 'server',
    )
    setAutoCommit(true)
    setPushAfterAcceptance(true)
    setAutoClose(true)
    setLocalCommand('')
    // Selection should only reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWorkItemId])

  const handleItemChange = (id: string) => {
    setWorkItemId(id)
    const item = workItems.find((entry) => entry.id === id)
    if (item) handleRepoChange(item.repoId)
  }

  const handleRepoChange = (id: string) => {
    setRepoId(id)
    setLocalCommand('')
    const repository = repositories.find((repo) => repo.id === id)
    setExecutionMode(repository?.localPath ? 'client' : 'server')
  }

  const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

  const buildLocalCommand = () => {
    const configuredApi = (import.meta.env.VITE_API_BASE as string | undefined)?.trim()
    const apiBase = configuredApi?.startsWith('http')
      ? configuredApi.replace(/\/api\/?$/, '')
      : window.location.origin
    const args = [
      'npm',
      'run',
      'deliver:local',
      '--',
      '--api',
      apiBase,
      '--work-item',
      workItemId,
      '--repo',
      repoId,
      '--path',
      selectedRepo?.localPath ?? '',
      '--branch',
      selectedRepo?.branch ?? '',
      '--run',
    ]
    if (!autoCommit) args.push('--no-commit')
    else if (pushAfterAcceptance) args.push('--push')
    if (autoClose) args.push('--close')
    return args.map(shellQuote).join(' ')
  }

  const copyLocalCommand = async () => {
    if (!selectedRepo?.localPath) {
      notify('缺少客户端代码路径', '请先到代码仓库配置当前客户端的绝对路径', 'warning')
      return
    }
    const command = buildLocalCommand()
    setLocalCommand(command)
    try {
      await navigator.clipboard.writeText(command)
      notify('本地交付命令已复制', '在 automationPrj 目录的终端中执行即可启动 Codex', 'success')
    } catch {
      notify('命令已生成', '浏览器未授予剪贴板权限，请从弹窗中手动复制', 'warning')
    }
  }

  const launch = async () => {
    if (launching) return
    if (executionMode === 'client') {
      await copyLocalCommand()
      return
    }
    setLaunching(true)
    try {
      const run = await startPipeline({ workItemId, repoId, autoCommit, autoClose })
      onClose()
      onStarted(run)
    } catch {
      // The data provider already reports the API error as a toast.
    } finally {
      setLaunching(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="启动一键交付"
      subtitle="自动完成需求解析、设计报告、编码、集成验证、提交、编译、升级与测试"
      size="lg"
      footer={
        <>
          <span className="modal-footer-hint">
            <ShieldCheck size={15} /> {executionMode === 'client'
              ? '代码、测试、提交与推送均在本机执行，远端只保存需求与仓库配置'
              : '服务端执行仅适用于后端与代码检出位于同一台主机'}
          </span>
          <div className="modal-footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={launch}
              disabled={!workItemId || !repoId || launching}
            >
              {launching
                ? '启动中…'
                : executionMode === 'client'
                  ? '生成并复制本地命令'
                  : '启动服务端交付'} <ArrowRight size={16} />
            </button>
          </div>
        </>
      }
    >
      <div className="delivery-dialog-grid">
        <div className="delivery-form">
          <Field label="选择需求或缺陷" required>
            <select value={workItemId} onChange={(event) => handleItemChange(event.target.value)}>
              {availableItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} · {item.title}
                </option>
              ))}
            </select>
          </Field>
          <div className="field-row">
            <Field label="目标代码仓库" required>
              <select value={repoId} onChange={(event) => handleRepoChange(event.target.value)}>
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="目标分支" hint="来自仓库配置">
              <div className="input-with-icon readonly-input">
                <GitBranch size={15} />
                <span>{selectedRepo?.branch ?? '-'}</span>
              </div>
            </Field>
          </div>

          <Field label="执行位置" hint="远端服务器无法访问客户端路径时，选择客户端本地执行">
            <select
              value={executionMode}
              onChange={(event) => setExecutionMode(event.target.value as 'client' | 'server')}
            >
              <option value="client">客户端本地（推荐）</option>
              <option value="server">服务端执行（仅本机后端）</option>
            </select>
          </Field>

          <Field
            label="客户端代码路径"
            hint={
              selectedRepo?.localPath
                ? '该路径由当前客户端执行脚本校验；代码、测试、提交与推送都在本机完成'
                : '未配置客户端路径，本次交付按模拟模式执行'
            }
          >
            <div className="input-with-icon readonly-input">
              <FolderGit2 size={15} />
              <span>{selectedRepo?.localPath || '未配置'}</span>
            </div>
          </Field>

          <div className="automation-options">
            <label className="check-row">
              <input
                type="checkbox"
                checked={autoCommit}
                onChange={(e) => {
                  setAutoCommit(e.target.checked)
                  if (!e.target.checked) setPushAfterAcceptance(false)
                }}
              />
              <span className="custom-check" />
              <span>
                <strong>自动提交代码</strong>
                <small>由本机执行脚本在客户端路径创建提交，验收通过后按授权推送目标分支</small>
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pushAfterAcceptance}
                disabled={!autoCommit}
                onChange={(e) => setPushAfterAcceptance(e.target.checked)}
              />
              <span className="custom-check" />
              <span>
                <strong>验收通过后推送</strong>
                <small>Codex 成功结束后再请求确认，将本地提交推送到目标分支</small>
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} />
              <span className="custom-check" />
              <span>
                <strong>自动关闭缺陷</strong>
                <small>测试通过后同步关闭飞书缺陷单</small>
              </span>
            </label>
          </div>

          {localCommand && (
            <Field label="本地执行命令（已复制）" hint="在 automationPrj 仓库根目录运行">
              <div className="credential-note">
                <Terminal size={16} />
                <div>
                  <code style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.7 }}>
                    {localCommand}
                  </code>
                  <button className="btn btn-secondary btn-xs" onClick={() => void copyLocalCommand()}>
                    <Copy size={12} /> 重新复制
                  </button>
                </div>
              </div>
            </Field>
          )}

          <div className="credential-note">
            <CheckCircle2 size={16} />
            <div>
              <strong>客户端执行说明</strong>
              <p>
                页面不会把 Mac 路径发送给远端执行。命令会在本机校验目录、分支和 origin，调用 Codex 完成设计、编码、验证与本地提交；加 <code>--push</code> 才会推送分支。
              </p>
            </div>
          </div>
        </div>

        <aside className="delivery-preview">
          <div className="delivery-preview-glow" />
          <span className="eyebrow light">
            <Sparkles size={13} /> DELIVERY PLAN
          </span>
          <h3>{selectedItem?.title ?? '请选择工作项'}</h3>
          <div className="preview-meta">
            {selectedItem && <StatusBadge status={selectedItem.type} />}
            {selectedItem && <StatusBadge status={selectedItem.priority} />}
            {selectedItem && <StatusBadge status={selectedItem.status} />}
          </div>
          <div className="preview-route">
            <div>
              <GitBranch size={15} />
              <span>{selectedRepo?.name ?? '-'}</span>
              <small>{selectedRepo?.branch ?? '-'}</small>
            </div>
            <div>
              <FileText size={15} />
              <span>解析 · 设计报告 · 自动编码</span>
              <small>生成技术方案、改动范围与测试策略</small>
            </div>
            <div>
              <GitMerge size={15} />
              <span>集成报告 · 提交 · 编译 · 升级 · 测试</span>
              <small>验证通过后推送 {selectedRepo?.branch ?? '目标分支'} 并生成测试报告</small>
            </div>
          </div>
          <div className="preview-footer">
            <span>9 个自动化阶段</span>
            <span>3 份交付报告</span>
          </div>
        </aside>
      </div>
    </Modal>
  )
}
