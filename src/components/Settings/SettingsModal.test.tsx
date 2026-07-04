import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsModal from './SettingsModal'
import { SettingsProvider } from '../../contexts/SettingsContext'

vi.mock('../../services/backup', () => ({
  backupService: { export: vi.fn(), import: vi.fn() },
}))
import { backupService } from '../../services/backup'
const backup = backupService as unknown as {
  export: ReturnType<typeof vi.fn>
  import: ReturnType<typeof vi.fn>
}

function renderModal(onClose = vi.fn()) {
  render(
    <SettingsProvider>
      <SettingsModal onClose={onClose} />
    </SettingsProvider>,
  )
  return { onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('SettingsModal — appearance & display', () => {
  it('marks a theme swatch pressed when selected', () => {
    renderModal()
    const darker = screen.getByRole('button', { name: 'Darker' })
    expect(darker).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(darker)
    expect(darker).toHaveAttribute('aria-pressed', 'true')
  })

  it('flips a display toggle between on and off', () => {
    renderModal()
    const authors = screen.getByRole('switch', { name: 'Show authors' })
    expect(authors).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(authors)
    expect(authors).toHaveAttribute('aria-checked', 'false')
  })

  it('selects a grid density segment', () => {
    renderModal()
    const compact = screen.getByRole('button', { name: 'Compact' })
    fireEvent.click(compact)
    expect(compact).toHaveAttribute('aria-pressed', 'true')
  })

  it('changes the default sort through the select', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(screen.getByRole('button', { name: ': Date saved' }))
    await user.click(screen.getByRole('option', { name: 'Title' }))
    expect(screen.getByRole('button', { name: ': Title' })).toBeInTheDocument()
  })
})

describe('SettingsModal — export', () => {
  it('formats the success feedback and clears it after 4s', async () => {
    vi.useFakeTimers()
    try {
      backup.export.mockResolvedValue({ itemCount: 12, fileSizeBytes: 2 * 1024 * 1024 })
      renderModal()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      })
      expect(screen.getByText('Saved — 12 items, 2.0 MB')).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(4000))
      expect(screen.queryByText(/Saved —/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays idle with no feedback when export returns null (cancelled save)', async () => {
    backup.export.mockResolvedValue(null)
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.queryByText(/Saved —/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('shows an error message when export throws', async () => {
    backup.export.mockRejectedValue(new Error('disk full'))
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText('disk full')).toBeInTheDocument()
  })

  it('shows a busy, disabled button while exporting', async () => {
    let resolve!: (v: unknown) => void
    backup.export.mockReturnValue(new Promise((r) => (resolve = r)))
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeDisabled()
    await act(async () => resolve(null))
  })

  it('falls back to a generic message when export rejects without one', async () => {
    backup.export.mockRejectedValue('nope')
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText('Export failed')).toBeInTheDocument()
  })
})

describe('SettingsModal — import (two-step confirm)', () => {
  it('requires confirmation and only imports on Replace', async () => {
    backup.import.mockResolvedValue(undefined)
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByText(/Replace your entire library/)).toBeInTheDocument()
    expect(backup.import).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(backup.import).toHaveBeenCalledOnce()
  })

  it('cancels back to idle without importing', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Replace your entire library/)).toBeNull()
    expect(backup.import).not.toHaveBeenCalled()
  })

  it('surfaces an import error', async () => {
    backup.import.mockRejectedValue(new Error('bad backup file'))
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(screen.getByText('bad backup file')).toBeInTheDocument()
  })

  it('falls back to a generic message when import rejects without one', async () => {
    backup.import.mockRejectedValue({})
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(screen.getByText('Import failed')).toBeInTheDocument()
  })
})

describe('SettingsModal — dismissal', () => {
  it('closes on Escape, overlay click, and the close button', () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(document.querySelector('.modal-overlay')!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('does not close when clicking inside the dialog', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
