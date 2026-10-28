import {
  Bell,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  FlaskConical,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Menu,
  Search,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useData } from '../store'
import type { PageKey } from '../types'
import { Avatar } from './ui'

const pageMeta: Record<PageKey, { label: string; group: string; title: string }> = {
  dashboard: { label: '工作台', group: '工作空间', title: '交付总览' },
  repositories: { label: '代码仓库', group: '工作空间', title: '代码仓库' },
  accounts: { label: '平台账号', group: '工作空间', title: '账号中心' },
  'work-items': { label: '需求与缺陷', group: '交付中心', title: '需求与缺陷' },
  pipelines: { label: '交付流水线', group: '交付中心', title: '交付流水线' },
  reports: { label: '测试报告', group: '交付中心', title: '测试报告' },
}

const navGroups: { label: string; items: { key: PageKey; icon: typeof LayoutDashboard }[] }[] = [
  {
    label: '工作空间',
    items: [
      { key: 'dashboard', icon: LayoutDashboard },
      { key: 'repositories', icon: GitBranch },
      { key: 'accounts', icon: KeyRound },
    ],
  },
  {
    label: '交付中心',
    items: [
      { key: 'work-items', icon: ClipboardList },
      { key: 'pipelines', icon: Workflow },
      { key: 'reports', icon: FlaskConical },
    ],
  },
]

const localOperator = {
  name: '本地管理员',
  role: '研发效能管理员',
}

export function Layout({
  page,
  onNavigate,
  children,
}: {
  page: PageKey
  onNavigate: (page: PageKey) => void
  children: ReactNode
}) {
  const { notify, workItems } = useData()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const meta = pageMeta[page]
  const openCount = workItems.filter(
    (item) => item.status === '待处理' || item.status === '进行中',
  ).length

  const navigate = (target: PageKey) => {
    onNavigate(target)
    setMobileOpen(false)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <span className="brand-orbit" />
            <span className="brand-planet" />
          </div>
          <div className="brand-copy">
            <strong>ORBIT</strong>
            <span>研发交付平台</span>
          </div>
          <button className="icon-btn sidebar-close" onClick={() => setMobileOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <button className="workspace-switcher">
          <span className="workspace-avatar">RC</span>
          <span>
            <strong>RJ Cloud</strong>
            <small>无线网络设备事业部</small>
          </span>
          <ChevronDown size={14} />
        </button>

        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.key}
                    className={`nav-item ${page === item.key ? 'active' : ''}`}
                    onClick={() => navigate(item.key)}
                  >
                    <span className="nav-icon-wrap">
                      <Icon size={18} strokeWidth={1.9} />
                    </span>
                    <span>{pageMeta[item.key].label}</span>
                    {item.key === 'work-items' && openCount > 0 && (
                      <span className="nav-count">{openCount}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="runner-card">
            <div className="runner-orbit">
              <span />
            </div>
            <div>
              <strong>后端数据服务</strong>
              <span>SQLite 持久化 · 实时同步</span>
            </div>
            <span className="online-dot" />
          </div>
          <button className="sidebar-user" onClick={() => setProfileOpen((value) => !value)}>
            <Avatar name={localOperator.name} />
            <span>
              <strong>{localOperator.name}</strong>
              <small>{localOperator.role}</small>
            </span>
            <ChevronDown size={14} className={profileOpen ? 'rotate-180' : ''} />
          </button>
        </div>
      </aside>

      {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-btn mobile-menu" onClick={() => setMobileOpen(true)}>
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              <span>{meta.group}</span>
              <i>/</i>
              <strong>{meta.title}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <label className="global-search">
              <Search size={16} />
              <input placeholder="搜索仓库、需求或测试报告" />
              <kbd>⌘ K</kbd>
            </label>
            <button
              className="icon-btn topbar-icon"
              aria-label="帮助"
              onClick={() => notify('帮助中心', '部署与接入说明请参考项目 README.md', 'info')}
            >
              <CircleHelp size={19} />
            </button>
            <button
              className="icon-btn topbar-icon"
              aria-label="通知"
              onClick={() => notify('通知中心', '当前没有新的系统通知', 'info')}
            >
              <Bell size={19} />
            </button>
            <div className="topbar-divider" />
            <button className="topbar-profile" onClick={() => setProfileOpen((value) => !value)}>
              <Avatar name={localOperator.name} size="sm" />
              <span>{localOperator.name}</span>
              <ChevronDown size={13} />
            </button>
            {profileOpen && (
              <div className="profile-menu">
                <div className="profile-menu-head">
                  <Avatar name={localOperator.name} />
                  <div>
                    <strong>{localOperator.name}</strong>
                    <span>本地部署工作区</span>
                  </div>
                </div>
                <button onClick={() => navigate('accounts')}>
                  <KeyRound size={15} /> 管理平台账号
                </button>
                <button onClick={() => navigate('pipelines')}>
                  <Workflow size={15} /> 查看执行记录
                </button>
                <div className="profile-menu-tip">
                  <Sparkles size={14} /> ORBIT 本地工作区
                </div>
              </div>
            )}
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  )
}
