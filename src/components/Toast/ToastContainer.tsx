import type { ToastType } from '../../contexts/ToastContext'

interface Props {
  toasts:    { id: string; message: string; type: ToastType }[]
  onDismiss: (id: string) => void
}

export default function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          {t.type === 'info'    && <span className="toast-spinner" />}
          {t.type === 'success' && <span className="toast-icon">✓</span>}
          {t.type === 'error'   && <span className="toast-icon toast-icon--error">✗</span>}
          <span className="toast-message">{t.message}</span>
          <button
            className="toast-dismiss"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
