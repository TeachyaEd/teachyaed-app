import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { useAuth } from '@/features/auth/hooks/useAuth';
import * as authService from '@/features/auth/api/authService';
import type { Profile } from '@/features/auth/types';

// Mocking the auth domain service (not the Supabase client itself) is
// the documented boundary for these lifecycle tests — see PHASE 2.1
// instructions. This proves AuthProvider's own state-machine and
// stale-response handling; it does NOT prove RLS or any server-side
// authorization behavior.
vi.mock('@/features/auth/api/authService');

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="userId">{auth.userId ?? 'none'}</span>
      <span data-testid="role">{auth.profile?.role ?? 'none'}</span>
    </div>
  );
}

function LogoutProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <button onClick={() => void auth.signOut()}>logout</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
}

const PROFILE_A: Profile = { id: 'user-a', school_id: 'school-1', role: 'teacher' };
const PROFILE_B: Profile = { id: 'user-b', school_id: 'school-1', role: 'admin' };

describe('AuthProvider lifecycle', () => {
  let authStateCallback: ((userId: string | null) => void) | null;
  let unsubscribeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    authStateCallback = null;
    unsubscribeSpy = vi.fn();
    vi.mocked(authService.onAuthStateChange).mockImplementation((cb) => {
      authStateCallback = cb;
      return unsubscribeSpy;
    });
  });

  it('bootstraps to signed_in for an authenticated session', async () => {
    vi.mocked(authService.getCurrentUserId).mockResolvedValue('user-a');
    vi.mocked(authService.fetchOwnProfile).mockResolvedValue(PROFILE_A);

    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed_in'));
    expect(screen.getByTestId('userId').textContent).toBe('user-a');
    expect(screen.getByTestId('role').textContent).toBe('teacher');
  });

  it('bootstraps to signed_out when there is no session', async () => {
    vi.mocked(authService.getCurrentUserId).mockResolvedValue(null);

    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed_out'));
    expect(authService.fetchOwnProfile).not.toHaveBeenCalled();
  });

  it('transitions to signed_in when onAuthStateChange fires after a signed-out bootstrap', async () => {
    vi.mocked(authService.getCurrentUserId).mockResolvedValue(null);
    vi.mocked(authService.fetchOwnProfile).mockResolvedValue(PROFILE_B);

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed_out'));

    act(() => {
      authStateCallback?.('user-b');
    });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed_in'));
    expect(screen.getByTestId('userId').textContent).toBe('user-b');
  });

  it('logout resets state to signed_out and calls the sign-out service exactly once', async () => {
    vi.mocked(authService.getCurrentUserId).mockResolvedValue('user-a');
    vi.mocked(authService.fetchOwnProfile).mockResolvedValue(PROFILE_A);
    vi.mocked(authService.signOut).mockResolvedValue(undefined);

    render(
      <AuthProvider>
        <LogoutProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed_in'));

    await act(async () => {
      screen.getByText('logout').click();
    });

    expect(authService.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status').textContent).toBe('signed_out');
  });

  it('a stale bootstrap response cannot overwrite a newer auth-state-driven load', async () => {
    let resolveBootstrapUserId!: (id: string | null) => void;
    vi.mocked(authService.getCurrentUserId).mockImplementation(
      () => new Promise((resolve) => { resolveBootstrapUserId = resolve; })
    );
    vi.mocked(authService.fetchOwnProfile).mockResolvedValue(PROFILE_A);

    renderWithProvider();

    act(() => {
      authStateCallback?.('user-b');
    });
    await waitFor(() => expect(screen.getByTestId('userId').textContent).toBe('user-b'));

    await act(async () => {
      resolveBootstrapUserId('user-a');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('userId').textContent).toBe('user-b');
  });

  it('does not throw or log an error when a pending load resolves after unmount', async () => {
    let resolveUserId!: (id: string | null) => void;
    vi.mocked(authService.getCurrentUserId).mockImplementation(
      () => new Promise((resolve) => { resolveUserId = resolve; })
    );
    vi.mocked(authService.fetchOwnProfile).mockResolvedValue(PROFILE_A);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderWithProvider();

    unmount();

    await act(async () => {
      resolveUserId('user-a');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('settles to one consistent signed_in state under StrictMode double-invocation', async () => {
    vi.mocked(authService.getCurrentUserId).mockResolvedValue('user-a');
    vi.mocked(authService.fetchOwnProfile).mockResolvedValue(PROFILE_A);

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>
    );

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed_in'));
    expect(screen.getByTestId('userId').textContent).toBe('user-a');
    expect(screen.getByTestId('role').textContent).toBe('teacher');
  });
});
