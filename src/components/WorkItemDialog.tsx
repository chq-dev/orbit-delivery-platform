import { AlertCircle, CheckSquare2, GitBranch, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useData } from '../store'
import type { Priority, WorkItem, WorkItemType } from '../types'
import { Field, Modal } from './ui'

export function WorkItemDialog({
  open,
  onClose,
  initialType = 'requirement',
  onCreated,
}: {
  open: boolean
  onClose: () => void
  initialType?: WorkItemType
  onCreated?: (item: WorkItem) => void
}) {
  const { repositories, addWorkItem } = useData()
  const [type, setType] = useState<WorkItemType>(initialType)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [designReference, setDesignReference] = useState('')
  const [priority, setPriority] = useState<Priority>('中')
  const [repoId, setRepoId] = useState(repositories[0]?.id ?? '')
  const [owner, setOwner] = useState('')
  const selectedRepo = repositories.find((repo) => repo.id === repoId)

  useEffect(() => {
    if (!open) return
    setType(initialType)
    setTitle('')
    setDescription('')
    setDesignReference('')
    setPriority('中')
    setRepoId(repositories[0]?.id ?? '')
    setOwner('')
  }, [initialType, open, repositories])

  const submit = async () => {
    if (!title.trim() || !description.trim() || !owner.trim() || !repoId) return
    try {
      const item = await addWorkItem({
        type,
        title: title.trim(),
        description: description.trim(),
        priority,
        repoId,
        branch: selectedRepo?.branch ?? 'develop',
        owner: owner.trim(),
        designReference: designReference.trim() || undefined,
      })
      onCreated?.(item)
      onClose()
    } catch {
      // The data provider already reports the API error as a toast.
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={type === 'requirement' ? '创建需求' : '登记缺陷'}
      subtitle="工作项将保存到本地数据库，并可直接发起自动化交付"
      footer={
        <>
          <span className="modal-footer-hint">
            {type === 'requirement' ? (
              <CheckSquare2 size={15} />
            ) : (
              <AlertCircle size={15} />
            )}
            {type === 'requirement' ? '创建后可一键发起交付' : '修复完成后可自动关闭缺陷'}
          </span>
          <div className="modal-footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={!title || !description || !owner.trim() || !repoId}
            >
              {type === 'requirement' ? '创建需求' : '登记缺陷'}
            </button>
          </div>
        </>
      }
    >
      <div className="type-toggle">
        <button
          className={type === 'requirement' ? 'active' : ''}
          onClick={() => setType('requirement')}
        >
          需求
        </button>
        <button className={type === 'defect' ? 'active' : ''} onClick={() => setType('defect')}>
          缺陷
        </button>
      </div>
      <Field label={type === 'requirement' ? '需求标题' : '缺陷标题'} required>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={type === 'requirement' ? '例如：交换机 VLAN 配置支持批量导入' : '例如：AP 漫游后终端无法续租地址'}
          autoFocus
        />
      </Field>
      <Field label={type === 'requirement' ? '需求描述' : '缺陷复现与影响'} required>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="补充背景、验收标准或复现步骤，帮助自动化引擎理解变更范围..."
          rows={4}
        />
      </Field>
      <Field
        label={type === 'requirement' ? '设计稿 / 设计说明（可选）' : '设计参考（可选）'}
        hint="支持文档链接、本地路径或设计要点，交付时作为 Codex 的设计输入"
      >
        <input
          value={designReference}
          onChange={(event) => setDesignReference(event.target.value)}
          placeholder="设计稿链接、本地设计文档路径或关键设计约束"
        />
      </Field>
      <div className="field-row field-row-3">
        <Field label="优先级" required>
          <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
            <option value="紧急">紧急</option>
            <option value="高">高</option>
            <option value="中">中</option>
            <option value="低">低</option>
          </select>
        </Field>
        <Field label="关联仓库" required>
          <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="负责人" required>
          <input
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            placeholder="请输入负责人"
          />
        </Field>
      </div>
      <div className="form-note">
        <GitBranch size={15} />
        <span>
          目标分支 <strong>{selectedRepo?.branch ?? '-'}</strong> · {selectedRepo?.language ?? '-'}
        </span>
        <span className="form-note-owner">
          <UserRound size={14} /> {owner}
        </span>
      </div>
    </Modal>
  )
}
