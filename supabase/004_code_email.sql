-- ============================================================
-- Packet — Migration 004: emailing the discount code
-- ============================================================
-- The code screen promises "Email me my 10% discount code".
-- Until this migration and netlify-functions/send-code.js existed,
-- that promise was not kept — the code appeared on screen and
-- nothing was sent. This adds the bookkeeping the sender needs.
--
-- Why the send is NOT done in Postgres: sending mail from a database
-- trigger means a failing mail provider can roll back or block a
-- perfectly good insert. Issuing the code and telling someone about
-- it are separate concerns, and the code must never fail to issue
-- because Resend had a bad afternoon.
--
-- Run this in the Supabase SQL editor after 001–003.
-- ============================================================

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS code_emailed_at timestamptz,
  -- Kept so a silent failure is visible in the admin rather than
  -- only in a Netlify log nobody thinks to open.
  ADD COLUMN IF NOT EXISTS code_email_error text;

-- Finding the ones that never went out, which is the query the admin
-- runs and the one worth having an index for.
CREATE INDEX IF NOT EXISTS assessments_code_not_emailed_idx
  ON assessments (created_at DESC)
  WHERE code_emailed_at IS NULL;


-- ── Sender identity ─────────────────────────────────────────
-- In settings rather than hard-coded, per the Packet convention that
-- operational values live in app_settings. Changing the from-address
-- must not need a deploy.
-- is_public stays FALSE on all three. Only send-code.js reads them, and it
-- uses the service role. There is no reason to hand the sending address to
-- anyone holding the anon key.
INSERT INTO app_settings (key, value, note, is_public) VALUES
  ('email_from_name',
   'Packet',
   'Display name on outgoing email.', false),
  ('email_from_address',
   'info@packetlabel.com',
   'Sending address. Must be on a domain verified in Resend, or every send fails.', false),
  ('email_reply_to',
   'info@packetlabel.com',
   'Where replies land. Keep this a real monitored inbox.', false)
ON CONFLICT (key) DO NOTHING;


-- ============================================================
-- After running this:
--   1. Netlify -> both sites -> Environment variables ->
--      RESEND_API_KEY = the key from resend.com/api-keys
--      (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already set
--      for manage-users.js and are reused here.)
--   2. Finish the assessment with your own address and check it lands.
--   3. In the admin, the Assessment page shows whether each code was
--      emailed. Anything sitting on "not sent" is worth a look.
-- ============================================================
