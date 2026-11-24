// Sign-in: Supabase Auth when the server is configured for it, otherwise the built-in accounts.
import { api } from './api.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
let cfg = null, client = null;

export async function authConfig() { return (cfg ??= await api('/api/config')); }

async function sb() {
  if (!client) {
    const { createClient } = await import(SUPABASE_JS);
    client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'wattwise-auth' } });
  }
  return client;
}

/** Signs in and opens a server session. Resolves with { role, name }. */
export async function signIn(email, password) {
  const c = await authConfig();
  if (c.auth !== 'supabase') return api('/api/login', { method: 'POST', body: { email, password } });
  const s = await sb();
  const { data, error } = await s.auth.signInWithPassword({ email, password });
  if (error) throw new Error(/invalid login/i.test(error.message) ? 'Email or password is incorrect' : error.message);
  return api('/api/session', { method: 'POST', body: { access_token: data.session.access_token } });
}

export async function signOut() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  if (cfg?.auth === 'supabase') await (await sb()).auth.signOut().catch(() => {});
}

/** Current Supabase access token (admins send it so the server can list profiles), or null. */
export async function supabaseToken() {
  const c = await authConfig();
  if (c.auth !== 'supabase') return null;
  const { data } = await (await sb()).auth.getSession();
  return data.session?.access_token || null;
}

export async function changePassword(email, current, next) {
  const c = await authConfig();
  if (c.auth !== 'supabase') return api('/api/me/password', { method: 'PUT', body: { current, next } });
  if (String(next).length < 6) throw new Error('Use at least 6 characters');
  const s = await sb();
  const { error: e1 } = await s.auth.signInWithPassword({ email, password: current });
  if (e1) throw new Error('Current password is incorrect');
  const { error: e2 } = await s.auth.updateUser({ password: next });
  if (e2) throw new Error(e2.message);
}
