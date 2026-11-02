// ============================================================
// Packet — talking to Shopify and Supabase from a Netlify function
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// SETUP (Netlify -> site -> Environment variables):
//   SHOPIFY_SHOP          518m0n-7k   (the part before .myshopify.com)
//   SHOPIFY_CLIENT_ID     from the Packet Outlet Link app, Dev Dashboard -> Settings
//   SHOPIFY_CLIENT_SECRET from the same page. Also checks Shopify's notifications.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   already set for manage-users
//
// Shopify's Dev Dashboard apps get a fresh access token from the client
// id and secret (the "client credentials grant"); each lasts 24 hours.
// A function asks for one when it starts. Nothing is stored.
// ============================================================

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';

function shopifyConfigured() {
  return !!(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

function shopHost() {
  return String(process.env.SHOPIFY_SHOP || '').replace(/\.myshopify\.com$/i, '') + '.myshopify.com';
}

let cachedToken = null, cachedUntil = 0;

async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const resp = await fetch('https://' + shopHost() + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    }).toString()
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('Shopify would not give an access token (' + resp.status + '): ' + text.slice(0, 200));
  const data = JSON.parse(text);
  cachedToken = data.access_token;
  cachedUntil = Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000;
  return cachedToken;
}

async function gql(query, variables) {
  const token = await accessToken();
  const resp = await fetch('https://' + shopHost() + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('Shopify ' + resp.status + ': ' + text.slice(0, 300));
  const data = JSON.parse(text);
  if (data.errors && data.errors.length) {
    throw new Error('Shopify: ' + data.errors.map(function (e) { return e.message; }).join('; ').slice(0, 400));
  }
  return data.data;
}

// Mutations report problems in userErrors rather than failing. Turn
// those into a thrown error so nothing is quietly half-done.
function must(payload, what) {
  const errs = payload && payload.userErrors;
  if (errs && errs.length) {
    throw new Error(what + ': ' + errs.map(function (e) {
      return (e.field ? e.field.join('.') + ' ' : '') + e.message;
    }).join('; ').slice(0, 400));
  }
  return payload;
}

// The same thin PostgREST wrapper the sourcing functions use.
function restClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = url + '/rest/v1/';
  const headers = { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  async function call(method, path, body, prefer) {
    const resp = await fetch(base + path, {
      method, headers: Object.assign({}, headers, prefer ? { prefer } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(method + ' ' + path.split('?')[0] + ' -> ' + resp.status + ' ' + text.slice(0, 300));
    return text ? JSON.parse(text) : null;
  }
  return {
    select: (table, query) => call('GET', table + '?' + query),
    insert: (table, rows, prefer) => call('POST', table, rows, prefer || 'return=representation'),
    patch:  (table, query, row) => call('PATCH', table + '?' + query, row, 'return=minimal'),
    upsert: (table, rows, onConflict, prefer) =>
      call('POST', table + '?on_conflict=' + onConflict, rows, prefer || 'resolution=merge-duplicates,return=representation')
  };
}

function supabaseConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Owner or staff only, from their own login token.
async function staffCaller(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(url + '/auth/v1/user', { headers: { apikey: key, authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const user = await r.json();
    if (!user || !user.id) return null;
    const pr = await fetch(url + '/rest/v1/user_profiles?select=role&id=eq.' + user.id,
      { headers: { apikey: key, authorization: 'Bearer ' + key } });
    const rows = await pr.json();
    const role = rows && rows[0] && rows[0].role;
    return ['owner', 'staff'].indexOf(role) > -1 ? { id: user.id, role: role } : null;
  } catch (err) {
    console.error('staffCaller failed', err);
    return null;
  }
}

function json(status, body) {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

module.exports = { API_VERSION, shopifyConfigured, supabaseConfigured, shopHost, gql, must, restClient, staffCaller, json };
