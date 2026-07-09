import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RecommendationCard, { sourceLabel, cardChips } from './RecommendationCard'
import type { Recommendation } from '../../types'

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  title: 'A Fic',
  author: 'Ficcer',
  coverUrl: null,
  sourceId: 'https://ao3/works/1',
  source: 'ao3',
  url: 'https://ao3/works/1',
  subjects: ['Harry Potter', 'Adventure', 'Angst', 'Fluff'],
  matchedTags: ['Harry Potter'],
  score: 0.9,
  ...over,
})

describe('sourceLabel', () => {
  it('maps each source to its badge label', () => {
    expect(sourceLabel('ao3')).toBe('AO3')
    expect(sourceLabel('ffn')).toBe('FFN')
    expect(sourceLabel('book')).toBe('Book')
  })
})

describe('cardChips', () => {
  it('shows matched taste tags with a heading when there is overlap', () => {
    expect(cardChips(rec({ matchedTags: ['Slow Burn'] }))).toEqual({
      heading: "Why you'll like this",
      chips: ['Slow Burn'],
    })
  })

  it('falls back to the top few own subjects (no heading) when nothing matched', () => {
    expect(cardChips(rec({ matchedTags: [], subjects: ['A', 'B', 'C', 'D'] }))).toEqual({
      heading: null,
      chips: ['A', 'B', 'C'],
    })
  })
})

describe('RecommendationCard', () => {
  const handlers = () => ({ onAdd: vi.fn(), onDismiss: vi.fn(), onOpen: vi.fn() })

  it('renders the badge, title, and matched chips', () => {
    render(<RecommendationCard rec={rec()} {...handlers()} />)
    expect(screen.getByText('AO3')).toBeInTheDocument()
    expect(screen.getByText('A Fic')).toBeInTheDocument()
    expect(screen.getByText("Why you'll like this")).toBeInTheDocument()
    expect(screen.getByText('Harry Potter')).toBeInTheDocument()
  })

  it('fires the right callback for each action', async () => {
    const h = handlers()
    const r = rec()
    render(<RecommendationCard rec={r} {...h} />)
    const user = userEvent.setup()

    await user.click(screen.getByText('+ Add to Library'))
    expect(h.onAdd).toHaveBeenCalledWith(r)

    await user.click(screen.getByText('Open'))
    expect(h.onOpen).toHaveBeenCalledWith(r)

    await user.click(screen.getByText('Not interested'))
    expect(h.onDismiss).toHaveBeenCalledWith(r, 'not-interested')

    await user.click(screen.getByText('Already read'))
    expect(h.onDismiss).toHaveBeenCalledWith(r, 'already-read')
  })
})
