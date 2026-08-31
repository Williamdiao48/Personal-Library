import { describe, it, expect, beforeEach } from 'vitest'
import { installMockApi } from '../../test/renderer/mockWindowApi'
import { authService } from './auth'

// The auth service is a thin pass-through to window.api.auth — lock the wiring
// (right method, right argument order), matching services.test.ts.
let api: any

beforeEach(() => {
  api = installMockApi()
})

describe('authService delegation', () => {
  it('isConfigured → api.auth.isConfigured', () => {
    authService.isConfigured()
    expect(api.auth.isConfigured).toHaveBeenCalledTimes(1)
  })
  it('getSession → api.auth.getSession', () => {
    authService.getSession()
    expect(api.auth.getSession).toHaveBeenCalledTimes(1)
  })
  it('signUp forwards email + password', () => {
    authService.signUp('a@b.com', 'secret123')
    expect(api.auth.signUp).toHaveBeenCalledWith('a@b.com', 'secret123')
  })
  it('signIn forwards email + password', () => {
    authService.signIn('a@b.com', 'secret123')
    expect(api.auth.signIn).toHaveBeenCalledWith('a@b.com', 'secret123')
  })
  it('signOut → api.auth.signOut', () => {
    authService.signOut()
    expect(api.auth.signOut).toHaveBeenCalledTimes(1)
  })
  it('confirmSignup forwards email + code', () => {
    authService.confirmSignup('a@b.com', '123456')
    expect(api.auth.confirmSignup).toHaveBeenCalledWith('a@b.com', '123456')
  })
  it('resendConfirmation forwards the email', () => {
    authService.resendConfirmation('a@b.com')
    expect(api.auth.resendConfirmation).toHaveBeenCalledWith('a@b.com')
  })
  it('onStateChange forwards the callback', () => {
    const cb = () => {}
    authService.onStateChange(cb)
    expect(api.auth.onStateChange).toHaveBeenCalledWith(cb)
  })
})
