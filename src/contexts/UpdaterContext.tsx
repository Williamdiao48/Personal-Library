import { createContext, useContext, useState } from 'react'

interface UpdaterCtx {
  pendingVersion: string | null
  setPendingVersion: (v: string | null) => void
}

const UpdaterContext = createContext<UpdaterCtx | null>(null)

export function UpdaterProvider({ children }: { children: React.ReactNode }) {
  const [pendingVersion, setPendingVersion] = useState<string | null>(null)
  return (
    <UpdaterContext.Provider value={{ pendingVersion, setPendingVersion }}>
      {children}
    </UpdaterContext.Provider>
  )
}

export function useUpdater(): UpdaterCtx {
  const ctx = useContext(UpdaterContext)
  if (!ctx) throw new Error('useUpdater must be inside UpdaterProvider')
  return ctx
}
