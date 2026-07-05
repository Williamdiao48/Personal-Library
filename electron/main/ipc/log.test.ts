import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, appendFileSync, rmSync } from 'fs'
import { registerLogHandlers } from './log'
import { invoke, resetIpc } from 'electron'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) }
})

const LOG_PATH = '/tmp/pl-test-userdata/logs/error-2026-07-05.log'

describe('registerLogHandlers', () => {
  beforeEach(() => {
    resetIpc()
    registerLogHandlers()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
    vi.mocked(appendFileSync).mockClear()
    rmSync(LOG_PATH, { force: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a timestamped entry to the date-keyed log file', async () => {
    await invoke('log:writeError', 'boom')
    expect(existsSync(LOG_PATH)).toBe(true)
    const contents = readFileSync(LOG_PATH, 'utf8')
    expect(contents).toBe('[2026-07-05T12:00:00.000Z]\nboom\n\n')
  })

  it('accumulates a second message rather than overwriting', async () => {
    await invoke('log:writeError', 'first')
    vi.setSystemTime(new Date('2026-07-05T12:05:00.000Z'))
    await invoke('log:writeError', 'second')
    const contents = readFileSync(LOG_PATH, 'utf8')
    expect(contents).toBe(
      '[2026-07-05T12:00:00.000Z]\nfirst\n\n' + '[2026-07-05T12:05:00.000Z]\nsecond\n\n',
    )
  })

  it('swallows write failures instead of rejecting', async () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => invoke('log:writeError', 'ignored')).not.toThrow()
  })
})
