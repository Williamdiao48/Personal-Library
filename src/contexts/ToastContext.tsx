import { createContext, useContext, useState, useCallback, useRef } from 'react'
import ToastContainer from '../components/Toast/ToastContainer'

export type ToastType = 'info' | 'success' | 'error'

interface Toast { id: string; message: string; type: ToastType; onClick?: () => void }

interface ToastCtx {
  addToast:    (message: string, type: ToastType, id?: string, onClick?: () => void) => string
  updateToast: (id: string, message: string, type: ToastType) => void
  removeToast: (id: string) => void
}

const ToastContext = createContext<ToastCtx | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts]   = useState<Toast[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const scheduleRemoval = useCallback((id: string, delay: number) => {
    const existing = timers.current.get(id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
      timers.current.delete(id)
    }, delay)
    timers.current.set(id, t)
  }, [])

  const addToast = useCallback((message: string, type: ToastType, id?: string, onClick?: () => void): string => {
    const toastId = id ?? crypto.randomUUID()
    setToasts(prev => {
      const existing = prev.findIndex(t => t.id === toastId)
      const toast: Toast = { id: toastId, message, type, onClick }
      return existing >= 0
        ? prev.map(t => t.id === toastId ? toast : t)
        : [...prev, toast]
    })
    // 'info' = in-progress spinner, stays until explicitly replaced via updateToast
    if (type !== 'info') scheduleRemoval(toastId, 4000)
    return toastId
  }, [scheduleRemoval])

  const updateToast = useCallback((id: string, message: string, type: ToastType) => {
    addToast(message, type, id)
  }, [addToast])

  const removeToast = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ addToast, updateToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
