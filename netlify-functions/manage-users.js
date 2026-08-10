// ============================================================
// Packet — Netlify Function: manage-users
// From the AXRIK starter kit under licence. Kit v1.1.0.
// Lets the OWNER manage staff logins without touching SQL.
// ============================================================
// Holds the Supabase SERVICE ROLE key server-side (never in the
// browser). Every request must carry the caller's login token; the
// function verifies that caller is an 'owner' before doing anything,
// so staff/customers can't use it even by calling it directly.
//
// This is what lets a non-technical client add/remove their own
// staff logins and reset passwords without you touching Supabase.
//
// Actions (POST { action, ... }):
//   list                      -> all logins with role
//   create  {email,password,role,full_name}
//   setRole {userId, role}   role is 'owner' or 'staff'
//   resetPassword {userId, password}
//   delete  {userId}
//
// SETUP (one-off): Netlify -> site -> Environment variables ->
//   SUPABASE_SERVICE_ROLE_KEY = <Supabase -> Settings -> API -> service_role>
//   SUPABASE_URL              = <your project URL>
// No npm deps — native fetch (Netlify Node 18+).
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;            // >>> set per project
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_ROLE = 'staff';                             // least privilege

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SERVICE_KEY || !SUPABASE_URL) return json(503, { error: 'User management not configured.' });

  // 1. Identify caller from bearer token
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Not signed in' });

  let caller;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, authorization: `Bearer ${token}` },
    });
    if (!r.ok) return json(401, { error: 'Invalid session' });
    caller = await r.json();
  } catch { return json(401, { error: 'Invalid session' }); }

  // 2. Caller must be admin
  if ((await getRole(caller.id)) !== 'owner') return json(403, { error: 'Owners only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  try {
    switch (body.action) {
      case 'list':          return json(200, { users: await listUsers() });
      case 'create':        return json(200, await createUser(body));
      case 'setRole':       return json(200, await setRole(body.userId, body.role));
      case 'resetPassword': return json(200, await adminUpdate(body.userId, { password: body.password }));
      case 'delete':
        if (body.userId === caller.id) return json(400, { error: "You can't delete your own login." });
        return json(200, await deleteUser(body.userId));
      default: return json(400, { error: 'Unknown action' });
    }
  } catch (err) {
    console.error('manage-users error', err);
    return json(502, { error: err.message || 'Request failed' });
  }
};

const adminHeaders = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };

async function getRole(id) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${id}&select=role`, { headers: adminHeaders });
  if (!r.ok) return DEFAULT_ROLE;
  const rows = await r.json();
  return (rows[0] && rows[0].role) || DEFAULT_ROLE;
}

async function listUsers() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: adminHeaders });
  if (!r.ok) throw new Error('Could not list users');
  const data = await r.json();
  const users = data.users || data || [];
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=id,role`, { headers: adminHeaders });
  const roleMap = Object.fromEntries((pr.ok ? await pr.json() : []).map(x => [x.id, x.role]));
  return users.map(u => ({ id: u.id, email: u.email, role: roleMap[u.id] || DEFAULT_ROLE, created_at: u.created_at }));
}

async function createUser({ email, password, role, full_name }) {
  if (!email || !password) throw new Error('Email and password are required');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: full_name ? { full_name } : {} }),
  });
  const u = await r.json();
  if (!r.ok) throw new Error(u.msg || u.error_description || u.error || 'Could not create user');
  await setRole(u.id, role === 'owner' ? 'owner' : DEFAULT_ROLE);
  return { ok: true, id: u.id };
}

async function setRole(userId, role) {
  if (!userId) throw new Error('Missing user');
  // Only these two can be granted here. supplier and customer arrive
  // with the Shopify build and are not handed out from this screen.
  const safeRole = role === 'owner' ? 'owner' : DEFAULT_ROLE;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: 'PATCH', headers: { ...adminHeaders, prefer: 'return=representation' },
    body: JSON.stringify({ role: safeRole }),
  });
  if (!r.ok) throw new Error('Could not set role');
  if (!(await r.json()).length) {
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ id: userId, role: safeRole }),
    });
  }
  return { ok: true };
}

async function adminUpdate(userId, fields) {
  if (!userId) throw new Error('Missing user');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT', headers: adminHeaders, body: JSON.stringify(fields),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.msg || 'Could not update user'); }
  return { ok: true };
}

async function deleteUser(userId) {
  if (!userId) throw new Error('Missing user');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders });
  if (!r.ok) throw new Error('Could not delete user');
  return { ok: true };
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
