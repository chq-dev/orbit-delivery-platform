import { Check, CheckCircle2, FileText, MessageSquare, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { feishuInbox, platformLinks } from '../mockData'
import { useData } from '../store'
import type { WorkItemType } from '../types'
import { Modal, StatusBadge } from './ui'

export function FeishuImportDialog({
  open,
  mode,
  onClose,
}: {
  open: boolean
  mode: WorkItemType
  onClose: () => void
}) {
  const { repositories, workItems, importWorkItems } = useData()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const available = useMemo(
    () => feishuInbox.filter((item) => item.type === mode),
    [mode],
  )
  const importedExternalIds = useMemo(
    () => new Set(workItems.map((item) => item.externalId).filter(Boolean)),
    [workItems],
  )
  const pending = available.filter((item) => !importedExternalIds.has(item.externalId))

  useEffect(() => {
    if (!open) return
    setSelected(new Set(pending.map((item) => item.externalId)))
    // Default to the currently available inbox items whenever the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode])

  const toggle = (externalId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(externalId)) next.delete(externalId)
      else next.add(externalId)
      return next
    })
  }

  const allSelected = pending.length > 0 && pending.every((item) => selected.has(item.externalId))
  const selectedCount = pending.filter((item) => selected.has(item.externalId)).length
  const sourceUrl = mode === 'requirement' ? platformLinks.feishuStory : platformLinks.feishuIssue
  const platformName = mode === 'requirement' ? '需求平台' : '缺陷平台'
  const ModeIcon = mode === 'requirement' ? FileText : MessageSquare

  const importSelected = () => {
    const items = pending.filter((item) => selected.has(item.externalId))
    if (items.length === 0) return
    importWorkItems(
      items.map((item) => {
        const repository = repositories.find((repo) => repo.id === item.repoId) ?? repositories[0]
        return {
          type: item.type,
          title: item.title,
          description: item.description,
          priority: item.priority,
          repoId: repository.id,
          branch: repository.branch,
          owner: item.owner,
          source: 'feishu' as const,
          externalId: item.externalId,
        }
      }),
    )
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`导入飞书${mode === 'requirement' ? '需求' : '缺陷'}`}
      subtitle="在当前平台完成同步与导入，不打开外部项目页面"
      size="lg"
      footer={
        <>
          <span className="modal-footer-hint">
            <ShieldCheck size={15} /> 仅写入本地工作项，不会跳转飞书
          </span>
          <div className="modal-footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" onClick={importSelected} disabled={!selectedCount}>
              导入 {selectedCount || ''} 条到本地
            </button>
          </div>
        </>
      }
    >
      <div className="feishu-local-source">
        <span className="feishu-local-logo"><ModeIcon size={18} /></span>
        <div>
          <strong>rjcloud · 飞书{platformName}</strong>
          <span>{sourceUrl}</span>
        </div>
        <span className="feishu-local-connected">
          <CheckCircle2 size={13} /> 本地连接正常
        </span>
      </div>

      <div className="feishu-inbox-head">
        <span>
          本地同步队列 <strong>{pending.length}</strong>
          {importedExternalIds.size > 0 && <small>已导入项自动去重</small>}
        </span>
        <button
          className="text-btn"
          onClick={() =>
            setSelected(allSelected ? new Set() : new Set(pending.map((item) => item.externalId)))
          }
          disabled={pending.length === 0}
        >
          {allSelected ? '取消全选' : '全选'}
        </button>
      </div>

      <div className="feishu-inbox-list">
        {available.map((item) => {
          const imported = importedExternalIds.has(item.externalId)
          const isSelected = selected.has(item.externalId)
          return (
            <button
              type="button"
              key={item.externalId}
              className={`feishu-inbox-item ${isSelected ? 'selected' : ''} ${imported ? 'imported' : ''}`}
              onClick={() => !imported && toggle(item.externalId)}
              disabled={imported}
            >
              <span className="feishu-inbox-check">
                {imported ? <Check size={12} strokeWidth={3} /> : isSelected ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              <span className="feishu-inbox-copy">
                <span className="feishu-inbox-title-row">
                  <strong>{item.title}</strong>
                  {imported && <span className="inbox-imported-label">已导入</span>}
                </span>
                <span className="feishu-inbox-description">{item.description}</span>
                <span className="feishu-inbox-meta">
                  {item.externalId} · {item.owner} · {item.updatedAt}
                </span>
              </span>
              <span className="feishu-inbox-side">
                <StatusBadge status={item.priority} />
              </span>
            </button>
          )
        })}
        {available.length === 0 && <div className="feishu-inbox-empty">当前没有可导入的工作项</div>}
      </div>
    </Modal>
  )
}
