// Copy this file to config.js and fill in the values from
// Supabase → Project Settings → API.
//
// IMPORTANT — read before assuming this file is a secret.
//
// The anon key is public by design. It ships in the page source of every
// Supabase site and is meant to. What protects the data is Row Level Security
// plus the SECURITY DEFINER functions in schema.sql: with this key alone you
// can call subscribe(), unsubscribe() and log_view() and nothing else. You
// cannot read the subscriber list.
//
// So config.js IS committed to the repo, unlike the usual Packet convention
// of a gitignored config. There is no build step here, so a gitignored config
// would simply be missing from the deployed site. The rule that matters is
// the one below.
//
// NEVER put the service_role key in this file, or anywhere else in this
// folder. It bypasses RLS entirely. If it ever leaks, rotate it immediately
// in the Supabase dashboard.

window.PACKET_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',

  // Instagram handle without the @. Leave empty to hide the link entirely.
  INSTAGRAM: '',

  // Shown on the landing page and in the privacy notice.
  CONTACT_EMAIL: 'info@packetlabel.com',

  // ---- Assessment offer, FALLBACK ONLY ------------------------------------
  // The live values come from the settings table, so they can be changed with
  // one line of SQL and no redeploy. These are used only when the database
  // cannot be reached — chiefly when someone opens the file straight off disk
  // to preview it. Keep them in step with the settings table so a preview
  // looks like the real thing.
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
