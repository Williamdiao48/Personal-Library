import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PendingRegistry } from './pending-registry'
import type { EpubParseResult } from './parse-protocol'

// Exercises the pure request-correlation core of parse-host (F7) without
// spawning a real utilityProcess. The fork/crash-restart wiring lives in
// parse-host.ts and is covered by manual verification.

function epub(plainText: string): EpubParseResult {
  return {
    title: null,
    author: null,
    coverBuffer: null,
    coverExt: null,
    plainText,
    wordCount: wordCountOf(plainText),
  }
}
function wordCountOf(t: string): number {
  return t.split(/\s+/).filter(Boolean).length
}

describe('PendingRegistry', () => {
  it('assigns incrementing ids', () => {
    const reg = new PendingRegistry()
    const a = reg.create<unknown>(1000, () => {})
    const b = reg.create<unknown>(1000, () => {})
    expect(b.id).toBeGreaterThan(a.id)
    expect(reg.size).toBe(2)
  })

  it('settle() resolves the matching request with its result', async () => {
    const reg = new PendingRegistry()
    const { id, promise } = reg.create<EpubParseResult>(1000, () => {})
    const result = epub('hi there')
    reg.settle({ id, ok: true, result })
    await expect(promise).resolves.toEqual(result)
    expect(reg.size).toBe(0)
  })

  it('settle() rejects the matching request on ok:false', async () => {
    const reg = new PendingRegistry()
    const { id, promise } = reg.create<unknown>(1000, () => {})
    reg.settle({ id, ok: false, error: 'boom' })
    await expect(promise).rejects.toThrow('boom')
    expect(reg.size).toBe(0)
  })

  it('ignores an unknown id without disturbing pending requests', async () => {
    const reg = new PendingRegistry()
    const { id, promise } = reg.create<EpubParseResult>(1000, () => {})
    reg.settle({ id: 9999, ok: true, result: epub('other') })
    expect(reg.size).toBe(1)
    reg.settle({ id, ok: true, result: epub('mine') })
    await expect(promise).resolves.toBeDefined()
  })

  it('correlates concurrent requests to the right promise', async () => {
    const reg = new PendingRegistry()
    const first = reg.create<EpubParseResult>(1000, () => {})
    const second = reg.create<EpubParseResult>(1000, () => {})
    // Settle out of order.
    reg.settle({ id: second.id, ok: true, result: epub('second') })
    reg.settle({ id: first.id, ok: true, result: epub('first') })
    expect((await first.promise).plainText).toBe('first')
    expect((await second.promise).plainText).toBe('second')
  })

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('rejects and cleans up on timeout, and fires onTimeout', async () => {
      const reg = new PendingRegistry()
      const onTimeout = vi.fn()
      const { id, promise } = reg.create<unknown>(500, onTimeout)
      const assertion = expect(promise).rejects.toThrow(/timed out/)
      vi.advanceTimersByTime(500)
      await assertion
      expect(reg.size).toBe(0)
      expect(onTimeout).toHaveBeenCalledWith(id)
    })
  })

  it('rejectAll() rejects every in-flight request and clears the map', async () => {
    const reg = new PendingRegistry()
    const a = reg.create<unknown>(1000, () => {})
    const b = reg.create<unknown>(1000, () => {})
    reg.rejectAll(new Error('worker died'))
    await expect(a.promise).rejects.toThrow('worker died')
    await expect(b.promise).rejects.toThrow('worker died')
    expect(reg.size).toBe(0)
  })
})
