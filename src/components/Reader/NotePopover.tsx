import { useEffect, useRef } from 'react'
import type { Annotation } from '../../types'

interface Props {
  x:          number   // center-x of the mark (clientX)
  y:          number   // top of the mark (clientY)
  annotation: Annotation
  onClose:    () => void
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

export default function NotePopover({ x, y, annotation, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Position: center horizontally on mark, appear above it (or below if near top)
  const left = Math.min(Math.max(x - 130, 8), window.innerWidth - 276)
  const above = y - 8 >= 120
  const top   = above ? y - 8 : y + 24   // rough height; we use transform to push up

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="note-popover"
      style={{
        left,
        top,
        transform: above ? 'translateY(-100%)' : undefined,
      }}
      onMouseDown={e => e.preventDefault()}
    >
      <button className="note-popover-close" onClick={onClose} aria-label="Close">×</button>
      {annotation.selected_text && (
        <p className="note-popover-quote">
          {truncate(annotation.selected_text, 100)}
        </p>
      )}
      <p className="note-popover-text">{annotation.note_text}</p>
    </div>
  )
}
