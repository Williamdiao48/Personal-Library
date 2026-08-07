import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'

// The processing IPC surface is a thin delegate — mock the driver and assert the
// channel mirrors the switch into it.
const h = vi.hoisted(() => ({ setCloudProcessingEnabled: vi.fn() }))
vi.mock('../cloud/processing', () => ({
  setCloudProcessingEnabled: h.setCloudProcessingEnabled,
}))

import { registerProcessingHandlers } from './processing'

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  registerProcessingHandlers()
})

describe('processing:setEnabled', () => {
  it('mirrors the switch into the driver', async () => {
    await invoke('processing:setEnabled', true)
    expect(h.setCloudProcessingEnabled).toHaveBeenCalledWith(true)
  })

  it('forwards a disable too', async () => {
    await invoke('processing:setEnabled', false)
    expect(h.setCloudProcessingEnabled).toHaveBeenCalledWith(false)
  })
})
