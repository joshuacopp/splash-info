import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { loadData } from '../lib/data'
import { buildIndex } from '../lib/calc'

const DataContext = createContext(null)

export function DataProvider({ children }) {
  const [dataset, setDataset] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const ds = await loadData()
      setDataset(ds)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const idx = useMemo(() => (dataset ? buildIndex(dataset) : null), [dataset])

  return (
    <DataContext.Provider value={{ dataset, idx, loading, error, refresh }}>
      {children}
    </DataContext.Provider>
  )
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
