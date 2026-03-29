interface Props {
  step:        string
  pct:         number
  error:       string | null
  onCancel:    () => void
  onOpenEpub?: () => void
}

export default function ConvertProgress({ step, pct, error, onCancel, onOpenEpub }: Props) {
  const done = pct >= 100 && !error

  return (
    <div className="convert-overlay">
      <div className="convert-modal">

        <h3 className="convert-title">Converting to EPUB</h3>

        {error ? (
          <p className="convert-error">{error}</p>
        ) : (
          <>
            <p className="convert-step">{step}</p>
            <div className="convert-bar-track">
              <div className="convert-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}

        <div className="convert-actions">
          {done && onOpenEpub && (
            <button className="convert-btn-primary" onClick={onOpenEpub}>
              Open EPUB
            </button>
          )}
          <button
            className={done || error ? 'convert-btn-secondary' : 'convert-btn-cancel'}
            onClick={onCancel}
          >
            {done ? 'Stay here' : error ? 'Close' : 'Cancel'}
          </button>
        </div>

      </div>
    </div>
  )
}
