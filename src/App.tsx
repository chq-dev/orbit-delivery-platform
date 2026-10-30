import { useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './auth'
import { Layout } from './components/Layout'
import { ToastStack } from './components/ui'
import { Accounts } from './pages/Accounts'
import { Dashboard } from './pages/Dashboard'
import { Pipelines } from './pages/Pipelines'
import { Reports } from './pages/Reports'
import { Repositories } from './pages/Repositories'
import { WorkItems } from './pages/WorkItems'
import { LoginPage } from './pages/Login'
import { DataProvider } from './store'
import type { PageKey } from './types'

const validPages: PageKey[] = [
  'dashboard',
  'repositories',
  'accounts',
  'work-items',
  'pipelines',
  'reports',
]

function pageFromHash(): PageKey {
  const value = window.location.hash.replace(/^#\/?/, '') as PageKey
  return validPages.includes(value) ? value : 'dashboard'
}

function AppContent() {
  const [page, setPage] = useState<PageKey>(pageFromHash)
  const [selectedId, setSelectedId] = useState<string>()

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [page])

  const navigate = (target: PageKey, id?: string) => {
    setSelectedId(id)
    setPage(target)
    window.location.hash = `/${target}`
  }

  return (
    <Layout page={page} onNavigate={(target) => navigate(target)}>
      {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
      {page === 'repositories' && <Repositories onNavigate={navigate} />}
      {page === 'accounts' && <Accounts />}
      {page === 'work-items' && <WorkItems onNavigate={navigate} />}
      {page === 'pipelines' && <Pipelines selectedRunId={selectedId} onNavigate={navigate} />}
      {page === 'reports' && <Reports selectedReportId={selectedId} onNavigate={navigate} />}
      <ToastStack />
    </Layout>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  )
}

function AuthenticatedApp() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="auth-loading">
        <span className="auth-loading-orbit" />
        <strong>正在验证登录状态</strong>
      </div>
    )
  }
  if (!user) return <LoginPage />
  return (
    <DataProvider>
      <AppContent />
    </DataProvider>
  )
}
