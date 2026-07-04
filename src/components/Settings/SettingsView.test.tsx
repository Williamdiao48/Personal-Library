import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import SettingsView from './SettingsView'
import { SettingsProvider } from '../../contexts/SettingsContext'
import { UpdaterProvider } from '../../contexts/UpdaterContext'

vi.mock('../../services/backup', () => ({
  backupService: { export: vi.fn(), import: vi.fn() },
}))
import { backupService } from '../../services/backup'
const backup = backupService as unknown as {
  export: ReturnType<typeof vi.fn>
  import: ReturnType<typeof vi.fn>
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <UpdaterProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/" element={<div>LIBRARY HOME</div>} />
          </Routes>
        </SettingsProvider>
      </UpdaterProvider>
    </MemoryRouter>,
  )
}

/** Open the editor and fill in a valid custom theme with the given name. */
function createTheme(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
  fireEvent.change(screen.getByPlaceholderText('My theme'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('SettingsView — navigation & appearance', () => {
  it('navigates back to the library', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '← Library' }))
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })

  it('selects a built-in theme swatch', () => {
    renderView()
    const nord = screen.getByRole('button', { name: 'Nord' })
    expect(nord).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(nord)
    expect(nord).toHaveAttribute('aria-pressed', 'true')
  })

  it('toggles display options, grid density, and default sort', async () => {
    const user = userEvent.setup()
    renderView()

    const authors = screen.getByRole('switch', { name: 'Show authors' })
    fireEvent.click(authors)
    expect(authors).toHaveAttribute('aria-checked', 'false')

    const progress = screen.getByRole('switch', { name: 'Show progress bar' })
    fireEvent.click(progress)
    expect(progress).toHaveAttribute('aria-checked', 'false')

    const comfortable = screen.getByRole('button', { name: 'Comfortable' })
    fireEvent.click(comfortable)
    expect(comfortable).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: ': Date saved' }))
    await user.click(screen.getByRole('option', { name: 'Last read' }))
    expect(screen.getByRole('button', { name: ': Last read' })).toBeInTheDocument()
  })
})

describe('SettingsView — custom theme editor', () => {
  it('disables Save until the name and hex fields are valid', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    const save = screen.getByRole('button', { name: 'Save theme' })
    expect(save).toBeDisabled() // name empty

    fireEvent.change(screen.getByPlaceholderText('My theme'), { target: { value: 'Sunset' } })
    expect(save).toBeEnabled()

    fireEvent.change(screen.getByPlaceholderText('#1a1a1a'), { target: { value: 'not-hex' } })
    expect(save).toBeDisabled() // invalid bg hex
  })

  it('hides the live preview swatch while a hex field is invalid', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    expect(screen.getByLabelText('Theme preview')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('#7c6aff'), { target: { value: '#zzz' } })
    expect(screen.queryByLabelText('Theme preview')).toBeNull()
  })

  it('syncs the hex field when a native color picker changes', () => {
    const { container } = renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    const [bgPicker, accentPicker] = Array.from(
      container.querySelectorAll<HTMLInputElement>('.custom-theme-color-picker'),
    )
    fireEvent.change(bgPicker, { target: { value: '#00ff00' } })
    expect(screen.getByPlaceholderText('#1a1a1a')).toHaveValue('#00ff00')
    fireEvent.change(accentPicker, { target: { value: '#ff00ff' } })
    expect(screen.getByPlaceholderText('#7c6aff')).toHaveValue('#ff00ff')
  })

  it('creates → edits → deletes a custom theme (round trip)', () => {
    renderView()

    // Create
    createTheme('Sunset')
    const row = screen
      .getByText('Sunset', { selector: '.custom-theme-row-name' })
      .closest('.custom-theme-row') as HTMLElement
    expect(row).not.toBeNull()
    // Selected as the active theme after creation
    expect(screen.getByRole('button', { name: 'Sunset' })).toHaveAttribute('aria-pressed', 'true')

    // Edit → rename
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByPlaceholderText('My theme'), { target: { value: 'Sunrise' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))
    expect(screen.getByText('Sunrise', { selector: '.custom-theme-row-name' })).toBeInTheDocument()
    expect(screen.queryByText('Sunset')).toBeNull()

    // Delete → gone, and the create button returns
    const row2 = screen
      .getByText('Sunrise', { selector: '.custom-theme-row-name' })
      .closest('.custom-theme-row') as HTMLElement
    fireEvent.click(within(row2).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByText('Sunrise')).toBeNull()
    expect(screen.getByRole('button', { name: '+ Create custom theme' })).toBeInTheDocument()
  })

  it('cancels the editor without adding a theme', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: '+ Create custom theme' })).toBeInTheDocument()
  })
})

describe('SettingsView — data export/import', () => {
  it('shows formatted export success feedback', async () => {
    backup.export.mockResolvedValue({ itemCount: 5, fileSizeBytes: 1024 * 1024 })
    renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText('Saved — 5 items, 1.0 MB')).toBeInTheDocument()
  })

  it('surfaces an export error', async () => {
    backup.export.mockRejectedValue(new Error('no disk'))
    renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText('no disk')).toBeInTheDocument()
  })

  it('stays idle when export returns null (cancelled save)', async () => {
    backup.export.mockResolvedValue(null)
    renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.queryByText(/Saved —/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('requires a two-step confirm before importing', async () => {
    backup.import.mockResolvedValue(undefined)
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByText(/Replace your entire library/)).toBeInTheDocument()
    expect(backup.import).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(backup.import).toHaveBeenCalledOnce()
  })

  it('surfaces an import error and cancels back to idle', async () => {
    backup.import.mockRejectedValue(new Error('corrupt archive'))
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(screen.getByText('corrupt archive')).toBeInTheDocument()
  })

  it('cancels the import confirmation', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Replace your entire library/)).toBeNull()
    expect(backup.import).not.toHaveBeenCalled()
  })
})

describe('SettingsView — developer tools', () => {
  it('simulates and clears a pending update notification', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }))
    const clear = screen.getByRole('button', { name: 'Clear (v99.9.9)' })
    expect(clear).toBeInTheDocument()
    fireEvent.click(clear)
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeInTheDocument()
  })
})
