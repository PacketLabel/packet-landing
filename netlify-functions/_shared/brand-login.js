// ============================================================
// Packet — making a brand login (shared)
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Used by manage-users.js (an owner making a login by hand) and by
// brand-onboard.js (approving a brand). One copy of the rules, so the
// two can never drift apart:
//
//   1. the brand must exist on the Brands page
//   2. the login is created already stamped packet_role = 'brand' in
//      its app metadata. Only the service key can set that; the brand
//      cannot change it. 014's trigger reads the stamp and makes the
//      profile a brand from the first instant, and current_user_role()
//      falls back to it if the profile row is ever missing.
//   3. the profile row is written again explicitly and read back
//   4. if 3 does not come back right, the login is deleted. A half-made
//      brand login is worse than none.
// ============================================================

function env() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url: url, headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' } };
}

async function createBrandLogin(opts) {
  const email = opts.email, password = opts.password, full_name = opts.full_name, brandId = opts.brandId;
  const E = env();
  if (!email || !password) throw new Error('Email and password are required');
  if (String(password).length < 8) throw new Error('The password needs to be at least eight characters');
  if (!/^[0-9a-f-]{36}$/i.test(String(brandId || ''))) throw new Error('Pick which brand this login is for');

  const br = await fetch(E.url + '/rest/v1/brands?id=eq.' + brandId + '&select=id,name', { headers: E.headers });
  const brands = br.ok ? await br.json() : [];
  if (!brands.length) throw new Error('That brand is not on the Brands page');

  const r = await fetch(E.url + '/auth/v1/admin/users', {
    method: 'POST', headers: E.headers,
    body: JSON.stringify({
      email: email, password: password, email_confirm: true,
      user_metadata: full_name ? { full_name: full_name } : {},
      app_metadata: { packet_role: 'brand', brand_id: brandId }
    })
  });
  const u = await r.json();
  if (!r.ok) throw new Error(u.msg || u.error_description || u.error || 'Could not create the login');

  try {
    const w = await fetch(E.url + '/rest/v1/user_profiles?on_conflict=id', {
      method: 'POST',
      headers: Object.assign({}, E.headers, { prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify({ id: u.id, role: 'brand', brand_id: brandId, full_name: full_name || '' })
    });
    if (!w.ok) throw new Error('profile write failed: ' + (await w.text()));
    const back = await fetch(E.url + '/rest/v1/user_profiles?id=eq.' + u.id + '&select=role,brand_id', { headers: E.headers });
    const rows = back.ok ? await back.json() : [];
    if (!rows[0] || rows[0].role !== 'brand' || rows[0].brand_id !== brandId) {
      throw new Error('profile did not read back as a brand');
    }
  } catch (err) {
    console.error('createBrandLogin rolled back', err);
    await fetch(E.url + '/auth/v1/admin/users/' + u.id, { method: 'DELETE', headers: E.headers }).catch(function () {});
    throw new Error('Could not finish setting up that login, so it has been removed. Has 014_outlet.sql been run?');
  }
  return { ok: true, id: u.id, brand: brands[0].name };
}

// The login, if one already exists for this email. Supabase's admin
// list has no exact email filter on every version, so page through.
async function findUserByEmail(email) {
  const E = env();
  const want = String(email || '').toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(E.url + '/auth/v1/admin/users?per_page=200&page=' + page, { headers: E.headers });
    if (!r.ok) return null;
    const d = await r.json();
    const users = d.users || d || [];
    const hit = users.filter(function (u) { return String(u.email || '').toLowerCase() === want; })[0];
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

// A one-off link that signs the brand in and asks for a password.
// It is a "recovery" link because that is the kind that lands on the
// set-a-password screen in brand.html; the login already exists.
async function setPasswordLink(email, redirectTo) {
  const E = env();
  const r = await fetch(E.url + '/auth/v1/admin/generate_link', {
    method: 'POST', headers: E.headers,
    body: JSON.stringify({ type: 'recovery', email: email, redirect_to: redirectTo, options: { redirect_to: redirectTo } })
  });
  const d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(d.msg || d.error_description || d.error || 'Could not make a sign-in link');
  const link = d.action_link || (d.properties && d.properties.action_link);
  if (!link) throw new Error('Supabase did not return a sign-in link');
  return link;
}

module.exports = { createBrandLogin, findUserByEmail, setPasswordLink };
