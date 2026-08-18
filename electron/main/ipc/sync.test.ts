import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import type { SyncStatus } from '../cloud/sync/syncService'

// The sync IPC surface is a thin delegate over syncService — mock the service and
// assert each channel wires to the right function and returns its status.
const STATUS: SyncStatus = {
  enabled: true,
  configured: true,
  signedIn: true,
  running: false,
  lastSyncedAt: 123,
  lastError: null,
  pendingDirty: 0,
  consecutiveFailures: 0,
  nextRetryAt: null,
}

const h = vi.hoisted(() => ({
  getStatus: vi.fn((): SyncStatus => STATUS),
  setEnabled: vi.fn(),
  syncNow: vi.fn((): Promise<SyncStatus> => Promise.resolve(STATUS)),
}))
vi.mock('../cloud/sync/syncService', () => ({
  getStatus: h.getStatus,
  setEnabled: h.setEnabled,
  syncNow: h.syncNow,
}))

import { registerSyncHandlers } from './sync'

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  registerSyncHandlers()
})

describe('sync:setEnabled', () => {
  it('mirrors the switch into the service and returns the resulting status', async () => {
    const res = await invoke('sync:setEnabled', true)
    expect(h.setEnabled).toHaveBeenCalledWith(true)
    expect(res).toEqual(STATUS)
  })
})

describe('sync:getStatus', () => {
  it('returns the current snapshot', async () => {
    const res = await invoke('sync:getStatus')
    expect(h.getStatus).toHaveBeenCalled()
    expect(res).toEqual(STATUS)
  })
})

describe('sync:now', () => {
  it('runs a manual round and returns its status', async () => {
    const res = await invoke('sync:now')
    expect(h.syncNow).toHaveBeenCalled()
    expect(res).toEqual(STATUS)
  })
})
