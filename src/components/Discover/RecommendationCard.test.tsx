import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RecommendationCard, { sourceLabel, cardChips } from './RecommendationCard'
import { fireResize } from '../../../test/renderer/setup'
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
  description: null,
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

describe('RecommendationCard description', () => {
  const handlers = () => ({ onAdd: vi.fn(), onDismiss: vi.fn(), onOpen: vi.fn() })
  const longDesc = 'A very long summary that would wrap well past the three-line clamp.'

  // jsdom does no layout, so scrollHeight/clientHeight are both 0 and nothing
  // reads as overflowing. Stub them on the clamped paragraph, then drive a resize
  // so the card re-measures and reveals the toggle.
  function forceOverflow(el: HTMLElement) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 100 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 42 })
    act(() => fireResize(el))
  }

  it('renders nothing for a null description', () => {
    const { container } = render(
      <RecommendationCard rec={rec({ description: null })} {...handlers()} />,
    )
    expect(container.querySelector('.rec-card-desc')).toBeNull()
  })

  it('shows the blurb but no toggle when it fits within the clamp', () => {
    render(<RecommendationCard rec={rec({ description: longDesc })} {...handlers()} />)
    expect(screen.getByText(longDesc)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
  })

  it('reveals a "Show more" toggle when the blurb overflows the clamp', () => {
    const { container } = render(
      <RecommendationCard rec={rec({ description: longDesc })} {...handlers()} />,
    )
    forceOverflow(container.querySelector('.rec-card-desc') as HTMLElement)
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
  })

  it('expands in place and collapses back on toggle click', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RecommendationCard rec={rec({ description: longDesc })} {...handlers()} />,
    )
    const p = container.querySelector('.rec-card-desc') as HTMLElement
    forceOverflow(p)

    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
    expect(p).toHaveClass('rec-card-desc--expanded')

    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
    expect(p).not.toHaveClass('rec-card-desc--expanded')
  })
})
