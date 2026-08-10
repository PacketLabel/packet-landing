// Live configuration for the Packet landing page.
//
// This file IS committed — see config.example.js for why, and read that note
// before assuming anything here is secret. In short: the anon key is public by
// design, and what protects the data is Row Level Security plus the narrow
// SECURITY DEFINER functions in schema.sql.
//
// NEVER put the service_role key in this file. It bypasses RLS entirely.

window.PACKET_CONFIG = {
  // Live values for the Packet project. Filled in 10 August 2026.
  //
  // Note the key format: Supabase has moved from anon/service_role to
  // publishable/secret. sb_publishable_… is the direct replacement for the
  // anon key and is used in exactly the same place.
  SUPABASE_URL: 'https://pulmpkkudwkbhzfshkzo.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_nZlU51XfKgfKxB9JHqqnUw_yv9luw8B',

  // Instagram handle without the @. Leave empty to hide the link entirely.
  INSTAGRAM: '',

  CONTACT_EMAIL: 'info@packetlabel.com',

  // ---- Assessment offer, FALLBACK ONLY ------------------------------------
  // The live values come from the settings table, so they can be changed with
  // one line of SQL and no redeploy. These are used only when the database
  // cannot be reached — chiefly when someone opens the file straight off disk
  // to preview it. Keep them in step with the settings table.
  //
  // Changing these does NOT change what the live site promises, and it does
  // not let a code be issued: the database refuses until discount_terms is
  // set there.
  DISCOUNT_PERCENT: '10',
  DISCOUNT_TERMS:
    '10% off your first order. One code per person, for a single order, ' +
    'and not to be used alongside another offer. No minimum spend. Valid ' +
    'for 12 months from the day we open. If you send something back that ' +
    'was bought with the code, we refund what you actually paid for it.'
};
