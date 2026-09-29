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
//   createBrandLogin {email,password,full_name,brandId}
//                            a login for an Outlet brand. It can only
//                            ever see that brand's own stock and orders.
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
      case 'createBrandLogin': return json(200, await createBrandLogin(body));
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
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=id,role,brand_id`, { headers: adminHeaders });
  const profs = Object.fromEntries((pr.ok ? await pr.json() : []).map(x => [x.id, x]));
  return users.map(u => {
    const p = profs[u.id] || {};
    // A login stamped as a brand is a brand even if its profile row is
    // missing — the same rule current_user_role() follows in 014.
    const stamped = u.app_metadata && u.app_metadata.packet_role === 'brand';
    return {
      id: u.id, email: u.email,
      role: p.role || (stamped ? 'brand' : DEFAULT_ROLE),
      brand_id: p.brand_id || null,
      created_at: u.created_at, last_sign_in_at: u.last_sign_in_at || null,
    };
  });
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
  // A brand login is never promoted. Turning one into staff would hand
  // an outside company the subscriber list, the cost prices and every
  // other brand's stock. If that is truly wanted, remove the login and
  // add the person again as staff, which is a deliberate act.
  if ((await getRole(userId)) === 'brand' || (await isStampedBrand(userId))) {
    throw new Error('That is a brand login. It cannot be made staff or owner.');
  }
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

// ── Brand logins (Packet Outlet) ─────────────────────────────
// The order matters, and every step is checked:
//   1. the brand must exist on the Brands page
//   2. the login is created already stamped packet_role = 'brand' in
//      its app metadata. Only this key can set that; the brand cannot
//      change it. 014's trigger reads the stamp and makes the profile
//      a brand from the first instant, and current_user_role() falls
//      back to it if the profile row is ever missing.
//   3. the profile row is written again explicitly and read back
//   4. if 3 does not come back right, the login is deleted. A half-made
//      brand login is worse than none.
async function createBrandLogin({ email, password, full_name, brandId }) {
  if (!email || !password) throw new Error('Email and password are required');
  if (String(password).length < 8) throw new Error('The password needs to be at least eight characters');
  if (!/^[0-9a-f-]{36}$/i.test(String(brandId || ''))) throw new Error('Pick which brand this login is for');

  const br = await fetch(`${SUPABASE_URL}/rest/v1/brands?id=eq.${brandId}&select=id,name`, { headers: adminHeaders });
  const brands = br.ok ? await br.json() : [];
  if (!brands.length) throw new Error('That brand is not on the Brands page');

  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: full_name ? { full_name } : {},
      app_metadata: { packet_role: 'brand', brand_id: brandId },
    }),
  });
  const u = await r.json();
  if (!r.ok) throw new Error(u.msg || u.error_description || u.error || 'Could not create the login');

  try {
    const w = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?on_conflict=id`, {
      method: 'POST',
      headers: { ...adminHeaders, prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ id: u.id, role: 'brand', brand_id: brandId, full_name: full_name || '' }),
    });
    if (!w.ok) throw new Error('profile write failed: ' + (await w.text()));
    const back = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${u.id}&select=role,brand_id`, { headers: adminHeaders });
    const rows = back.ok ? await back.json() : [];
    if (!rows[0] || rows[0].role !== 'brand' || rows[0].brand_id !== brandId) {
      throw new Error('profile did not read back as a brand');
    }
  } catch (err) {
    console.error('createBrandLogin rolled back', err);
    await deleteUser(u.id).catch(() => {});
    throw new Error('Could not finish setting up that login, so it has been removed. Has 014_outlet.sql been run?');
  }
  return { ok: true, id: u.id, brand: brands[0].name };
}

async function isStampedBrand(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders });
  if (!r.ok) return false;
  const u = await r.json();
  return !!(u && u.app_metadata && u.app_metadata.packet_role === 'brand');
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
