import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, screen } from '@testing-library/react'
import { ToastProvider, useToast } from './ToastContext'

function setup() {
  return renderHook(() => useToast(), { wrapper: ToastProvider })
}

describe('ToastContext', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('renders a toast and auto-removes non-info types after 4s', () => {
    const { result } = setup()
    act(() => {
      result.current.addToast('Saved', 'success')
    })
    expect(screen.getByText('Saved')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('keeps an info toast pinned past 4s (in-progress spinner)', () => {
    const { result } = setup()
    act(() => {
      result.current.addToast('Working…', 'info')
    })
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })

  it('replaces a toast by id instead of adding a duplicate', () => {
    const { result } = setup()
    act(() => {
      result.current.addToast('Working…', 'info', 'job1')
    })
    act(() => {
      result.current.updateToast('job1', 'Done', 'success')
    })
    expect(screen.queryByText('Working…')).toBeNull()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getAllByText(/Working|Done/)).toHaveLength(1)
  })

  it('resets the auto-remove countdown when the same id is re-added', () => {
    const { result } = setup()
    act(() => {
      result.current.addToast('First', 'success', 'k')
    })
    act(() => vi.advanceTimersByTime(3000)) // 3s in — not yet removed
    act(() => {
      result.current.addToast('Second', 'success', 'k') // replaces + reschedules
    })
    act(() => vi.advanceTimersByTime(3000)) // 6s since first add, but only 3s since reschedule
    expect(screen.getByText('Second')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000)) // now 4s since reschedule
    expect(screen.queryByText('Second')).toBeNull()
  })

  it('removeToast dismisses immediately', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addToast('Bye', 'error')
    })
    expect(screen.getByText('Bye')).toBeInTheDocument()
    act(() => result.current.removeToast(id))
    expect(screen.queryByText('Bye')).toBeNull()
  })

  it('useToast throws when used outside a provider', () => {
    expect(() => renderHook(() => useToast())).toThrow(/ToastProvider/)
  })
})
