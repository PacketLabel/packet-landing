// ============================================================
// Packet — Netlify Function: brand-shop-cron
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// The ten-minute run of the shop link (netlify.toml): takes Packet
// sales off each connected brand's Shopify stock, then reads their
// tagged products. A separate function because Netlify will not let a
// scheduled function also be called from the screens.
// ============================================================

const main = require('./brand-shop.js');

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  if (!body.next_run) return { statusCode: 404, body: '' };
  return main.runScheduled(event);
};
