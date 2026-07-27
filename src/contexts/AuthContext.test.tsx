import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider, useAuth } from './AuthContext'

// Mock the service layer the context sits on.
const svc = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  getSession: vi.fn(),
  signUp: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  onStateChange: vi.fn(() => () => {}),
}))
vi.mock('../services/auth', () => ({ authService: svc }))

function Consumer() {
  const { user, configured, loading, signIn, signUp, signOut } = useAuth()
  if (loading) return <div>loading</div>
  return (
    <div>
      <div data-testid="configured">{String(configured)}</div>
      <div data-testid="user">{user ? user.email : 'none'}</div>
      <button onClick={() => void signIn('a@b.com', 'pw')}>signin</button>
      <button onClick={() => void signUp('c@d.com', 'longpassword')}>signup</button>
      <button onClick={() => void signOut()}>signout</button>
    </div>
  )
}

function renderConsumer() {
  return render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  svc.onStateChange.mockReturnValue(() => {})
})

describe('AuthContext', () => {
  it('unconfigured build: no session lookup, user null', async () => {
    svc.isConfigured.mockResolvedValue(false)
    renderConsumer()
    await waitFor(() => expect(screen.getByTestId('configured')).toHaveTextContent('false'))
    expect(screen.getByTestId('user')).toHaveTextContent('none')
    expect(svc.getSession).not.toHaveBeenCalled()
    expect(svc.onStateChange).not.toHaveBeenCalled()
  })

  it('configured: hydrates the existing session and subscribes', async () => {
    svc.isConfigured.mockResolvedValue(true)
    svc.getSession.mockResolvedValue({ user: { id: 'u1', email: 'a@b.com' } })
    renderConsumer()
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@b.com'))
    expect(svc.onStateChange).toHaveBeenCalledTimes(1)
  })

  it('signIn success updates the user', async () => {
    svc.isConfigured.mockResolvedValue(true)
    svc.getSession.mockResolvedValue({ user: null })
    svc.signIn.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@b.com' } })
    renderConsumer()
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'))
    await userEvent.click(screen.getByText('signin'))
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@b.com'))
  })

  it('signUp needing confirmation does NOT sign the user in', async () => {
    svc.isConfigured.mockResolvedValue(true)
    svc.getSession.mockResolvedValue({ user: null })
    svc.signUp.mockResolvedValue({
      ok: true,
      user: { id: 'u2', email: 'c@d.com' },
      needsConfirmation: true,
    })
    renderConsumer()
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'))
    await userEvent.click(screen.getByText('signup'))
    // Still signed out — must confirm email first.
    await waitFor(() => expect(svc.signUp).toHaveBeenCalled())
    expect(screen.getByTestId('user')).toHaveTextContent('none')
  })

  it('signOut clears the user', async () => {
    svc.isConfigured.mockResolvedValue(true)
    svc.getSession.mockResolvedValue({ user: { id: 'u1', email: 'a@b.com' } })
    svc.signOut.mockResolvedValue(undefined)
    renderConsumer()
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@b.com'))
    await userEvent.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'))
  })

  it('a pushed state change updates the user', async () => {
    svc.isConfigured.mockResolvedValue(true)
    svc.getSession.mockResolvedValue({ user: null })
    let pushed: ((s: any) => void) | undefined
    svc.onStateChange.mockImplementation((cb: any) => {
      pushed = cb
      return () => {}
    })
    renderConsumer()
    await waitFor(() => expect(svc.onStateChange).toHaveBeenCalled())
    act(() => pushed?.({ user: { id: 'u9', email: 'pushed@b.com' } }))
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('pushed@b.com'))
  })
})
