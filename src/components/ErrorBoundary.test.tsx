import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

// A child that throws until a module-level flag is flipped, so we can test recovery.
let shouldThrow = true
function MaybeBoom() {
  if (shouldThrow) throw new Error('kaboom')
  return <div>recovered content</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  shouldThrow = true
  ;(window as unknown as { api: unknown }).api = {
    log: { writeError: vi.fn().mockResolvedValue(undefined) },
  }
})

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>happy path</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('happy path')).toBeInTheDocument()
  })

  it('renders the fallback and logs the error when a child throws', () => {
    // React logs the caught error to console.error — expected, benign.
    render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('kaboom')).toBeInTheDocument()
    expect(window.api.log.writeError).toHaveBeenCalled()
  })

  it('recovers when "Try again" is clicked after the cause is resolved', () => {
    render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    shouldThrow = false // the underlying problem is fixed
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('recovered content')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).toBeNull()
  })
})
