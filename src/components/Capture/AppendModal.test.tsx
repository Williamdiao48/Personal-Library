import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import AppendModal from './AppendModal'
import type { Item } from '../../types'

vi.mock('../../services/capture', () => ({
  captureService: { append: vi.fn() },
}))
import { captureService } from '../../services/capture'
const cap = captureService as unknown as Record<string, ReturnType<typeof vi.fn>>

const item = (over: Partial<Item> = {}): Item =>
  ({
    id: 'i1',
    title: 'Serial',
    source_url: 'https://site/story',
    chapter_start: 1,
    chapter_end: 10,
    ...over,
  }) as Item

function renderModal(over: Partial<React.ComponentProps<typeof AppendModal>> = {}) {
  const props = { item: item(), onClose: vi.fn(), onJobStarted: vi.fn(), ...over }
  render(<AppendModal {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('AppendModal', () => {
  it('shows the currently-saved chapter range', () => {
    renderModal()
    expect(screen.getByText(/Chapters 1–10/)).toBeInTheDocument()
  })

  it('rejects a target at or below the current end', () => {
    renderModal()
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByText(/higher than 10/)).toBeInTheDocument()
    expect(cap.append).not.toHaveBeenCalled()
  })

  it('starts an append job for a higher target', async () => {
    cap.append.mockResolvedValue('job-1')
    const props = renderModal()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Append' }))
    })
    expect(cap.append).toHaveBeenCalledWith('i1', 20)
    expect(props.onJobStarted).toHaveBeenCalledWith('job-1', 'https://site/story')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('labels the job with the title when there is no source URL', async () => {
    cap.append.mockResolvedValue('job-x')
    const props = renderModal({
      item: item({ source_url: null, chapter_start: null, chapter_end: 5 }),
    })
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '9' } })
    await act(async () => {
      fireEvent.submit(input.closest('form')!)
    })
    expect(props.onJobStarted).toHaveBeenCalledWith('job-x', 'Serial')
  })

  it('surfaces an error when the append fails', async () => {
    cap.append.mockRejectedValue(new Error('network down'))
    renderModal()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Append' }))
    })
    expect(screen.getByText('network down')).toBeInTheDocument()
  })

  it('closes on Cancel', () => {
    const props = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
