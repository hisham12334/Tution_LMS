const apiBase = import.meta.env.VITE_API_BASE_URL || '';
export const arrivingFromEmail = new URLSearchParams(window.location.search).has('token')
  || new URLSearchParams(window.location.search).get('setup') === 'invite';
export const passwordResetToken = new URLSearchParams(window.location.search).get('token');

export async function api<T = void>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...init.headers },
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json().catch(() => null) as { error?: string } | T | null;
  const serverError = value && typeof value === 'object' ? (value as { error?: string }).error : undefined;
  if (!response.ok) throw new Error(serverError || 'The request could not be completed.');
  return value as T;
}

export async function signIn(email: string, password: string) {
  const response = await fetch(`${apiBase}/api/auth/sign-in/email`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const result = await response.json().catch(() => null) as { message?: string; error?: { message?: string }; user?: unknown } | null;
  if (!response.ok || result?.error) throw new Error(result?.error?.message || result?.message || 'Sign in failed.');
}

export async function signOut() {
  await fetch(`${apiBase}/api/auth/sign-out`, { method: 'POST', credentials: 'include' });
}

export async function resetPasswordRequest(email: string) {
  await api('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email, redirectTo: `${window.location.origin}/?setup=reset` }) });
}

export async function setPassword(token: string, newPassword: string) {
  await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
}
