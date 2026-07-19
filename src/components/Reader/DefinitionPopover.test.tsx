import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import DefinitionPopover from './DefinitionPopover'
import { installMockApi } from '../../../test/renderer/mockWindowApi'
import type { DictionaryResult } from '../../types'

let api: ReturnType<typeof installMockApi>

function lookupResolves(result: DictionaryResult) {
  api.dictionary.lookup.mockResolvedValue(result)
}

beforeEach(() => {
  api = installMockApi()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('DefinitionPopover', () => {
  it('shows a loading state, then renders senses grouped by POS with example + synonyms', async () => {
    lookupResolves({
      word: 'book',
      found: true,
      entries: [
        {
          pos: 'noun',
          senses: [{ definition: 'a written work', example: 'a good book', synonyms: ['volume'] }],
        },
        { pos: 'verb', senses: [{ definition: 'reserve in advance', synonyms: [] }] },
      ],
    })
    render(<DefinitionPopover word="book" x={100} y={100} onClose={vi.fn()} />)

    expect(screen.getByText('Looking up…')).toBeInTheDocument()

    expect(await screen.findByText('a written work')).toBeInTheDocument()
    expect(screen.getByText('reserve in advance')).toBeInTheDocument()
    expect(screen.getByText('noun')).toBeInTheDocument()
    expect(screen.getByText('verb')).toBeInTheDocument()
    expect(screen.getByText(/a good book/)).toBeInTheDocument()
    expect(screen.getByText(/Synonyms: volume/)).toBeInTheDocument()
    expect(api.dictionary.lookup).toHaveBeenCalledWith('book')
  })

  it('shows the resolved lemma as the headword (geese → goose)', async () => {
    lookupResolves({
      word: 'goose',
      found: true,
      entries: [{ pos: 'noun', senses: [{ definition: 'a web-footed bird', synonyms: [] }] }],
    })
    render(<DefinitionPopover word="geese" x={0} y={0} onClose={vi.fn()} />)
    expect(await screen.findByText('goose')).toBeInTheDocument()
  })

  it('renders a not-found state for an unknown word', async () => {
    lookupResolves({ word: 'zzxqty', found: false, entries: [] })
    render(<DefinitionPopover word="zzxqty" x={0} y={0} onClose={vi.fn()} />)
    expect(await screen.findByText(/No definition found for/)).toBeInTheDocument()
  })

  it('closes on Escape and on the close button', async () => {
    lookupResolves({ word: 'book', found: false, entries: [] })
    const onClose = vi.fn()
    render(<DefinitionPopover word="book" x={0} y={0} onClose={onClose} />)
    await screen.findByText(/No definition found/)

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('degrades to not-found if the lookup rejects', async () => {
    api.dictionary.lookup.mockRejectedValue(new Error('boom'))
    render(<DefinitionPopover word="book" x={0} y={0} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/No definition found for/)).toBeInTheDocument())
  })
})
