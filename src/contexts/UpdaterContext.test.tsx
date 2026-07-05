import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { UpdaterProvider, useUpdater } from './UpdaterContext'

function setup() {
  return renderHook(() => useUpdater(), { wrapper: UpdaterProvider })
}

describe('UpdaterContext', () => {
  it('starts with no pending version', () => {
    const { result } = setup()
    expect(result.current.pendingVersion).toBeNull()
  })

  it('setPendingVersion updates state', () => {
    const { result } = setup()
    act(() => {
      result.current.setPendingVersion('1.2.3')
    })
    expect(result.current.pendingVersion).toBe('1.2.3')
  })

  it('useUpdater throws when used outside a provider', () => {
    expect(() => renderHook(() => useUpdater())).toThrow(/UpdaterProvider/)
  })
})
