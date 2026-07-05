import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ToastContainer from './ToastContainer'
import type { ToastType } from '../../contexts/ToastContext'

type Toast = { id: string; message: string; type: ToastType; onClick?: () => void }

function renderContainer(toasts: Toast[], onDismiss = vi.fn()) {
  render(<ToastContainer toasts={toasts} onDismiss={onDismiss} />)
  return { onDismiss }
}

beforeEach(() => vi.clearAllMocks())

describe('ToastContainer', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer toasts={[]} onDismiss={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a message per toast with a type class', () => {
    renderContainer([
      { id: 'a', message: 'Working', type: 'info' },
      { id: 'b', message: 'Done', type: 'success' },
      { id: 'c', message: 'Failed', type: 'error' },
    ])
    expect(screen.getByText('Working').closest('.toast')).toHaveClass('toast--info')
    expect(screen.getByText('Done').closest('.toast')).toHaveClass('toast--success')
    expect(screen.getByText('Failed').closest('.toast')).toHaveClass('toast--error')
  })

  it('makes a toast clickable when it has an onClick', () => {
    const onClick = vi.fn()
    renderContainer([{ id: 'a', message: 'Update', type: 'info', onClick }])
    const toast = screen.getByRole('button', { name: /Update/ })
    expect(toast).toHaveClass('toast--clickable')
    fireEvent.click(toast)
    expect(onClick).toHaveBeenCalled()
  })

  it('dismisses without triggering the toast onClick', () => {
    const onClick = vi.fn()
    const { onDismiss } = renderContainer([{ id: 'a', message: 'x', type: 'info', onClick }])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith('a')
    expect(onClick).not.toHaveBeenCalled() // stopPropagation
  })
})
