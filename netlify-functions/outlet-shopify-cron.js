// ============================================================
// Packet — Netlify Function: outlet-shopify-cron
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// The ten-minute run of outlet-shopify (netlify.toml). A separate
// function because Netlify will not let a scheduled function also be
// called from the admin's buttons. Same code, scheduled entry only.
// ============================================================

const main = require('./outlet-shopify.js');

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  if (!body.next_run) return { statusCode: 404, body: '' };
  return main.runScheduled(event);
};
