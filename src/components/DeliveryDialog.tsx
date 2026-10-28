import {
  ArrowRight,
  FileText,
  FolderGit2,
  GitBranch,
  GitMerge,
  ShieldCheck,
  Sparkles,
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
  const { workItems, repositories, startPipeline } = useData()
  const [workItemId, setWorkItemId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [autoCommit, setAutoCommit] = useState(true)
  const [autoClose, setAutoClose] = useState(true)
  const [launching, setLaunching] = useState(false)

  const availableItems = workItems.filter((item) => item.status !== '已关闭')
  const selectedItem = workItems.find((item) => item.id === workItemId)
  const selectedRepo = repositories.find((repo) => repo.id === repoId)

  useEffect(() => {
    if (!open) return
    const preferred = availableItems.find((item) => item.id === initialWorkItemId) ?? availableItems[0]
    setWorkItemId(preferred?.id ?? '')
    setRepoId(preferred?.repoId ?? repositories[0]?.id ?? '')
    setAutoCommit(true)
    setAutoClose(true)
    // Selection should only reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWorkItemId])

  const handleItemChange = (id: string) => {
    setWorkItemId(id)
    const item = workItems.find((entry) => entry.id === id)
    if (item) setRepoId(item.repoId)
  }

  const launch = async () => {
    if (launching) return
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
            <ShieldCheck size={15} /> 提交到配置的本地路径，测试验收通过后推送目标分支
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
              {launching ? '启动中…' : '启动交付'} <ArrowRight size={16} />
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
              <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
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

          <Field
            label="本地代码路径"
            hint={
              selectedRepo?.localPath
                ? '提交阶段在此目录创建真实 Git 提交，测试通过后推送到远端目标分支'
                : '未配置本地路径，本次交付按模拟模式执行'
            }
          >
            <div className="input-with-icon readonly-input">
              <FolderGit2 size={15} />
              <span>{selectedRepo?.localPath || '未配置'}</span>
            </div>
          </Field>

          <div className="automation-options">
            <label className="check-row">
              <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
              <span className="custom-check" />
              <span>
                <strong>自动提交代码</strong>
                <small>在本地路径创建提交，验收通过后推送目标分支</small>
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
