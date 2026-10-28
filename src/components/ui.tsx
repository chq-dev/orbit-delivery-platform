import { X, CheckCircle2, Info, AlertTriangle } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useData } from '../store'

const avatarColors = ['#5b5ce2', '#0f9f87', '#ef7b32', '#d14f8e', '#2575d9', '#64748b']

function avatarColor(name: string) {
  const hash = [...name].reduce((total, char) => total + char.charCodeAt(0), 0)
  return avatarColors[hash % avatarColors.length]
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.body.classList.add('modal-open')
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('modal-open')
    }
  }, [onClose, open])

  if (!open) return null

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

const badgeMap: Record<string, { label: string; tone: string }> = {
  running: { label: '执行中', tone: 'blue' },
  success: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  queued: { label: '排队中', tone: 'gray' },
  pending: { label: '待执行', tone: 'gray' },
  active: { label: '正常', tone: 'green' },
  expiring: { label: '即将过期', tone: 'orange' },
  healthy: { label: '健康', tone: 'green' },
  warning: { label: '需关注', tone: 'orange' },
  待处理: { label: '待处理', tone: 'gray' },
  进行中: { label: '进行中', tone: 'blue' },
  已交付: { label: '已交付', tone: 'green' },
  已关闭: { label: '已关闭', tone: 'purple' },
  紧急: { label: '紧急', tone: 'red' },
  高: { label: '高', tone: 'orange' },
  中: { label: '中', tone: 'blue' },
  低: { label: '低', tone: 'gray' },
  requirement: { label: '需求', tone: 'purple' },
  defect: { label: '缺陷', tone: 'red' },
  passed: { label: '通过', tone: 'green' },
  warningReport: { label: '有风险', tone: 'orange' },
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const item = badgeMap[status] ?? { label: status, tone: 'gray' }
  return (
    <span className={`badge badge-${item.tone}`}>
      <span className="badge-dot" />
      {label ?? item.label}
    </span>
  )
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ background: avatarColor(name) }}
      title={name}
    >
      {name.slice(0, 1)}
    </span>
  )
}

export function Field({
  label,
  hint,
  required,
  children,
  className = '',
}: {
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">
        {label}
        {required && <em>*</em>}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  )
}

export function ToastStack() {
  const { toasts, dismissToast } = useData()
  const icons = {
    success: <CheckCircle2 size={19} />,
    info: <Info size={19} />,
    warning: <AlertTriangle size={19} />,
  }
  return createPortal(
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <span className="toast-icon">{icons[toast.tone]}</span>
          <div className="toast-copy">
            <strong>{toast.title}</strong>
            <p>{toast.message}</p>
          </div>
          <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="关闭通知">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">∅</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}
