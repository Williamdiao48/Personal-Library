import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { GRID_GAP, MIN_COL_WIDTH } from '../constants/layout'

export interface GridColumns {
  /** Attach to the scroll container that bounds the grid. */
  mainRef: RefObject<HTMLElement>
  columnsPerRow: number
  colWidth: number
}

/**
 * Measures a scroll container and derives the column count + exact pixel width
 * of an auto-fill ItemCard grid, mirroring
 * `repeat(auto-fill, minmax(MIN_COL_WIDTH, 1fr))`. Shared by LibraryView and
 * CollectionView (audit RED-1) so card widths stay identical across both and the
 * geometry only lives in one place.
 */
export function useGridColumns(): GridColumns {
  const mainRef = useRef<HTMLElement>(null)
  const [columnsPerRow, setColumnsPerRow] = useState(4)
  const [colWidth, setColWidth] = useState(MIN_COL_WIDTH)

  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      const cols = Math.max(1, Math.floor((width + GRID_GAP) / (MIN_COL_WIDTH + GRID_GAP)))
      setColumnsPerRow(cols)
      setColWidth(Math.floor((width - (cols - 1) * GRID_GAP) / cols))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return { mainRef, columnsPerRow, colWidth }
}
