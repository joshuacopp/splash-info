import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { useData } from './context/DataContext'
import { Spinner, Banner } from './components/ui'
import Layout from './components/Layout'
import MasterDashboard from './pages/MasterDashboard'
import Inventory from './pages/Inventory'
import Attention from './pages/Attention'
import LocationDashboard from './pages/LocationDashboard'
import UsageTrends from './pages/UsageTrends'
import PackageEditor from './pages/PackageEditor'
import AdminProducts from './pages/AdminProducts'
import NewVisit from './pages/NewVisit'
import History from './pages/History'
import VisitDetail from './pages/VisitDetail'

export default function App() {
  const { ready, authed } = useAuth()
  const { loading, error } = useData()

  if (!ready) return <Spinner label="Starting up…" />
  // AuthContext redirects unauthenticated users to the splash login page; while
  // that navigation happens we just show a spinner (no in-app login form).
  if (!authed) return <Spinner label="Redirecting to sign in…" />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Gate loading={loading} error={error} el={<MasterDashboard />} />} />
        <Route path="inventory" element={<Gate loading={loading} error={error} el={<Inventory />} />} />
        <Route path="admin" element={<Gate loading={loading} error={error} el={<AdminProducts />} />} />
        <Route path="attention" element={<Gate loading={loading} error={error} el={<Attention />} />} />
        <Route
          path="location/:locationId"
          element={<Gate loading={loading} error={error} el={<LocationDashboard />} />}
        />
        <Route
          path="location/:locationId/trends"
          element={<Gate loading={loading} error={error} el={<UsageTrends />} />}
        />
        <Route
          path="location/:locationId/packages"
          element={<Gate loading={loading} error={error} el={<PackageEditor />} />}
        />
        <Route
          path="location/:locationId/new"
          element={<Gate loading={loading} error={error} el={<NewVisit />} />}
        />
        <Route
          path="location/:locationId/history"
          element={<Gate loading={loading} error={error} el={<History />} />}
        />
        <Route
          path="location/:locationId/visit/:visitId"
          element={<Gate loading={loading} error={error} el={<VisitDetail />} />}
        />
        <Route
          path="location/:locationId/visit/:visitId/edit"
          element={<Gate loading={loading} error={error} el={<NewVisit />} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

function Gate({ loading, error, el }) {
  if (error)
    return (
      <Banner tone="rose" title="Could not load data">
        {error}
      </Banner>
    )
  if (loading) return <Spinner />
  return el
}
