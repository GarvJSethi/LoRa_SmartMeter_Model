// Supabase Auth: verifies the access token a browser got from Supabase, and reads roles from public.profiles.
// Roles live in a table users cannot write to (RLS), so a user can never make themselves admin.
import { config } from './config.js';

export const supabaseEnabled = () => !!(config.supabaseUrl && config.supabaseAnonKey);

async function sb(path, { token, method = 'GET', body, service = false, headers = {} } = {}) {
  const key = service ? config.supabaseServiceKey : config.supabaseAnonKey;
  const res = await fetch(`${config.supabaseUrl}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${service ? key : token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.msg || data?.message || data?.error_description || data?.error || `Supabase error ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

/** The Supabase user behind an access token (throws if the token is invalid or expired). */
export const getAuthUser = token => sb('/auth/v1/user', { token });

/** The caller's own profile row (id, full_name, role). */
export async function getOwnProfile(token, id) {
  const rows = await sb(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,full_name,role`, { token });
  return rows?.[0] || null;
}

/** Every profile with its email. Works with an admin's token (RLS policy) or the service key. */
export async function listProfiles(token) {
  return sb('/rest/v1/profiles?select=id,full_name,role,email,created_at&order=role.desc,full_name', { token, service: !token && !!config.supabaseServiceKey });
}

// ---- admin actions that need the service_role key (optional; set SUPABASE_SERVICE_ROLE_KEY in .env)
export const canManageUsers = () => !!config.supabaseServiceKey;

export async function createAuthUser({ email, password, fullName, role }) {
  const u = await sb('/auth/v1/admin/users', { service: true, method: 'POST', body: { email, password, email_confirm: true, user_metadata: { full_name: fullName } } });
  await setProfile(u.id, { full_name: fullName, role, email });
  return u;
}
export const setProfile = (id, fields) =>
  sb(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { service: true, method: 'PATCH', body: fields, headers: { Prefer: 'return=minimal' } });
export const setAuthPassword = (id, password) =>
  sb(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { service: true, method: 'PUT', body: { password } });
export const deleteAuthUser = id => sb(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { service: true, method: 'DELETE' });
