import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import AddItemModal from './AddItemModal'
import type { Item } from '../../types'

vi.mock('../../services/capture', () => ({
  captureService: { start: vi.fn(), fromFile: vi.fn() },
}))
vi.mock('../../services/library', () => ({
  libraryService: { findBySourceUrl: vi.fn(), getById: vi.fn() },
}))

// The cloud opt-in reads auth + settings. Mock both with mutable state so the
// default is "signed out / cloud off" (toggle hidden — matches every existing
// test), and the cloud-path tests can flip it on.
const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: string; email: string | null } | null, configured: false },
  settings: { cloudBackupEnabled: false, cloudBackupDefault: false },
  updateSettings: vi.fn(),
  addToast: vi.fn(),
}))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings: mocks.settings, updateSettings: mocks.updateSettings }),
}))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ addToast: mocks.addToast }) }))

import { captureService } from '../../services/capture'
import { libraryService } from '../../services/library'
const cap = captureService as unknown as Record<string, ReturnType<typeof vi.fn>>
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

function renderModal(over: Partial<React.ComponentProps<typeof AddItemModal>> = {}) {
  const props = {
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onJobStarted: vi.fn(),
    ...over,
  }
  render(<AddItemModal {...props} />)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  lib.findBySourceUrl.mockResolvedValue(undefined)
  // Reset the cloud opt-in to "signed out / off" before each test.
  mocks.auth = { user: null, configured: false }
  mocks.settings = { cloudBackupEnabled: false, cloudBackupDefault: false }
})

describe('AddItemModal — URL capture', () => {
  it('starts a capture job for a fresh URL', async () => {
    cap.start.mockResolvedValue('job-1')
    const props = renderModal()
    fireEvent.change(screen.getByPlaceholderText('https://...'), {
      target: { value: 'https://a.com/x' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(cap.start).toHaveBeenCalledWith('https://a.com/x', undefined, undefined, false)
    expect(props.onJobStarted).toHaveBeenCalledWith('job-1', 'https://a.com/x')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('passes a chapter range when one is entered', async () => {
    cap.start.mockResolvedValue('job-2')
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('https://...'), {
      target: { value: 'https://a.com/x' },
    })
    fireEvent.click(screen.getByRole('button', { name: '+ Chapter range' }))
    fireEvent.change(screen.getByPlaceholderText('1'), { target: { value: '3' } })
    fireEvent.change(screen.getByPlaceholderText('last'), { target: { value: '8' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(cap.start).toHaveBeenCalledWith('https://a.com/x', 3, 8, false)
  })

  it('ignores an empty URL submission', async () => {
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(lib.findBySourceUrl).not.toHaveBeenCalled()
    expect(cap.start).not.toHaveBeenCalled()
  })

  it('warns about a duplicate and can add anyway', async () => {
    lib.findBySourceUrl.mockResolvedValue({ id: 'dup', title: 'Existing' })
    cap.start.mockResolvedValue('job-3')
    const props = renderModal()
    fireEvent.change(screen.getByPlaceholderText('https://...'), {
      target: { value: 'https://a.com/x' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(screen.getByText('Existing')).toBeInTheDocument()
    expect(cap.start).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add anyway' }))
    })
    expect(cap.start).toHaveBeenCalledWith('https://a.com/x', undefined, undefined, false)
    expect(props.onJobStarted).toHaveBeenCalled()
  })

  it('surfaces a capture error', async () => {
    cap.start.mockRejectedValue(new Error('capture boom'))
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('https://...'), {
      target: { value: 'https://a.com/x' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(screen.getByText('capture boom')).toBeInTheDocument()
  })
})

describe('AddItemModal — file import', () => {
  it('imports a picked file and reports the saved item', async () => {
    cap.fromFile.mockResolvedValue({ id: 'f1', title: 'Book' })
    lib.getById.mockResolvedValue({ id: 'f1', title: 'Book' } as Item)
    const props = renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(cap.fromFile).toHaveBeenCalled()
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }))
  })

  it('errors when the saved item cannot be retrieved', async () => {
    cap.fromFile.mockResolvedValue({ id: 'f1', title: 'Book' })
    lib.getById.mockResolvedValue(undefined)
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(screen.getByText(/could not be retrieved/)).toBeInTheDocument()
  })

  it('does nothing when the file picker is cancelled', async () => {
    cap.fromFile.mockResolvedValue(null)
    const props = renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(props.onSaved).not.toHaveBeenCalled()
  })

  it('surfaces an import error', async () => {
    cap.fromFile.mockRejectedValue(new Error('bad file'))
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(screen.getByText('bad file')).toBeInTheDocument()
  })

  it('toasts and closes on a duplicate — without inserting a (phantom) card', async () => {
    cap.fromFile.mockResolvedValue({ id: 'dup1', title: 'Dup Book', duplicate: true })
    const props = renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.stringContaining('already in your library'),
      'success',
    )
    // The item already exists in the list — inserting it again (onSaved) is the
    // phantom-card bug, so we close instead and never fetch it.
    expect(props.onSaved).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
    expect(lib.getById).not.toHaveBeenCalled()
  })

  it('does not toast for a normal (non-duplicate) import', async () => {
    cap.fromFile.mockResolvedValue({ id: 'f1', title: 'Book' })
    lib.getById.mockResolvedValue({ id: 'f1', title: 'Book' } as Item)
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(mocks.addToast).not.toHaveBeenCalled()
  })
})

describe('AddItemModal — cloud backup opt-in', () => {
  const signedInWithCloud = () => {
    mocks.auth = { user: { id: 'u1', email: 'a@b.com' }, configured: true }
    mocks.settings = { cloudBackupEnabled: true, cloudBackupDefault: false }
  }

  it('hides the toggle when signed out (nothing can be uploaded)', () => {
    renderModal()
    expect(screen.queryByText('Back up to cloud')).not.toBeInTheDocument()
  })

  it('hides the toggle when signed in but the master switch is off', () => {
    mocks.auth = { user: { id: 'u1', email: 'a@b.com' }, configured: true }
    mocks.settings = { cloudBackupEnabled: false, cloudBackupDefault: true }
    renderModal()
    expect(screen.queryByText('Back up to cloud')).not.toBeInTheDocument()
  })

  it('shows the toggle and captures local-only when its remembered default is off', async () => {
    signedInWithCloud()
    cap.start.mockResolvedValue('job-1')
    renderModal()
    expect(screen.getByText('Back up to cloud')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('https://...'), {
      target: { value: 'https://a.com/x' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(cap.start).toHaveBeenCalledWith('https://a.com/x', undefined, undefined, false)
  })

  it('captures with cloud backup when the remembered default is on', async () => {
    signedInWithCloud()
    mocks.settings.cloudBackupDefault = true
    cap.start.mockResolvedValue('job-1')
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('https://...'), {
      target: { value: 'https://a.com/x' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(cap.start).toHaveBeenCalledWith('https://a.com/x', undefined, undefined, true)
  })

  it('remembers the choice by persisting it to settings', () => {
    signedInWithCloud()
    renderModal()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ cloudBackupDefault: true })
  })

  it('passes the opt-in to file imports too', async () => {
    signedInWithCloud()
    mocks.settings.cloudBackupDefault = true
    cap.fromFile.mockResolvedValue({ id: 'f1', title: 'Book' })
    lib.getById.mockResolvedValue({ id: 'f1', title: 'Book' } as Item)
    renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse files...' }))
    })
    expect(cap.fromFile).toHaveBeenCalledWith(true)
  })
})

describe('AddItemModal — dismissal', () => {
  it('prefills an initial URL and closes on Cancel', () => {
    const props = renderModal({ initialUrl: 'https://seed.com' })
    expect(screen.getByDisplayValue('https://seed.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
