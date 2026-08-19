-- ============================================================
-- Packet — Migration 008: The ask box
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Lets either owner type a plain-English instruction into the
-- admin — "add Lookfantastic as a competitor", "start watching
-- for Bonfire Night", "stop tracking the shamrock stuff" — and
-- have the sourcing tool carry it out, without anyone having to
-- go through Phil or through Claude.
--
-- Run order: 001 -> ... -> 007 -> 008.
--
-- ── The shape of the thing ──────────────────────────────────
-- Typing a sentence does not change anything. It produces a
-- PROPOSAL: a list of specific actions, written back in plain
-- English, that sits on the screen until somebody presses the
-- confirm button. Only then is anything written.
--
-- ── What it is allowed to touch ─────────────────────────────
-- Data only: competitors, suppliers, seasons and the words that
-- make a product seasonal. That is the whole list and it is
-- enforced HERE, in a CHECK constraint, not in the page and not
-- in the prompt.
--
-- The reason is worth stating plainly. An instruction typed into
-- a box is text, and text can be wrong, mistyped, or — if a
-- competitor's product title ever ends up quoted into one — not
-- written by us at all. So the boundary cannot live anywhere
-- that text can reach. A prompt is a request. A CHECK constraint
-- is a wall.
--
-- Specifically OUT OF REACH, permanently:
--   · sourcing_settings — every fee, rate and threshold. Money
--     maths stays deterministic code entered by a human.
--   · category_settings.requires_uk_rp — the Responsible Person
--     gate. It is a compliance control, owner-only, and it is
--     the single rule most worth protecting from a hurried
--     sentence.
--   · suppliers.is_uk_responsible_person — same reason.
--   · opportunities — it cannot approve, reject or list anything.
--   · anything in auth, user_profiles, or the subscriber tables.
-- ============================================================


-- ── assistant_requests ──────────────────────────────────────
-- One row per question asked. Kept whether or not it was carried
-- out, because "who changed the competitor list and why" is a
-- question that gets asked three months later.
--
-- This doubles as the audit trail. Worth knowing: while both
-- owners share one login, asked_by identifies the ACCOUNT, not
-- the person. The question text is usually the better clue as to
-- who typed it. Separate logins fix this properly.
CREATE TABLE IF NOT EXISTS assistant_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  question     text NOT NULL,
  asked_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  asked_at     timestamptz NOT NULL DEFAULT now(),

  -- What the tool proposes to do, already validated against the
  -- allow-list below. Never the raw model output.
  actions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The same thing in a sentence, which is what the person
  -- actually reads before pressing the button.
  preview      text,

  -- Where the proposal came from. 'ai' or 'pattern' — the second
  -- being the built-in non-AI parser that handles the obvious
  -- phrasings when the AI is unavailable. Always paired, per the
  -- kit rule that no AI feature is ever the only path.
  parsed_by    text NOT NULL DEFAULT 'ai' CHECK (parsed_by IN ('ai','pattern','none')),

  status       text NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed','applied','rejected','failed','not_understood')),
  applied_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  applied_at   timestamptz,
  result       text,

  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_requests_status_idx
  ON assistant_requests (status, asked_at DESC);


-- ── The allow-list, as a wall ───────────────────────────────
-- Every action in the proposal must be an object with a `type`
-- drawn from this list. Anything else and the whole row is
-- refused at write time.
--
-- Adding a new capability means editing this constraint, on
-- purpose. It should be a deliberate act with a migration
-- attached, not something that can be talked into existence.
-- Guarded against a non-array on the way in, because a CHECK
-- constraint's AND is not promised to short-circuit and
-- jsonb_array_elements would raise rather than return false.
CREATE OR REPLACE FUNCTION assistant_actions_allowed(actions jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(actions) <> 'array' THEN false ELSE COALESCE(bool_and(
    jsonb_typeof(a) = 'object'
    -- a->>'type' rather than the ? operator: some clients treat a
    -- bare ? in SQL as a bind placeholder and mangle it.
    AND a->>'type' IS NOT NULL
    AND a->>'type' IN (
      'add_competitor',
      'pause_competitor',
      'resume_competitor',
      'add_supplier',
      'add_season',
      'pause_season',
      'resume_season',
      'add_season_term',
      'remove_season_term',
      'set_season_lead_times'
    )
  ), true) END
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(actions) = 'array' THEN actions ELSE '[]'::jsonb END
  ) AS a;
$$;

ALTER TABLE assistant_requests DROP CONSTRAINT IF EXISTS assistant_actions_within_allowlist;
ALTER TABLE assistant_requests ADD CONSTRAINT assistant_actions_within_allowlist
  CHECK (jsonb_typeof(actions) = 'array' AND assistant_actions_allowed(actions));

COMMENT ON CONSTRAINT assistant_actions_within_allowlist ON assistant_requests IS
  'The boundary of what a typed instruction can do. Money settings and the Responsible Person flag are deliberately absent and must stay absent.';


-- set_season_lead_times deserves a note, because it is the one
-- entry on the list that writes a number.
--
-- It is allowed because the number is a fact somebody has been
-- told — "the supplier says eight weeks" — rather than a rate the
-- tool would otherwise invent, and because the alternative is
-- that the calendar sits blank forever and nobody bothers. It is
-- bounded below, and every one of these appears in the confirm
-- step showing the old value next to the new one.
--
-- It writes to seasons. It cannot reach sourcing_settings, which
-- is where the money lives.


-- ── Nothing writes without a human ──────────────────────────
-- Belt and braces alongside the front end: a row cannot move to
-- 'applied' without somebody recorded against it.
CREATE OR REPLACE FUNCTION enforce_assistant_confirmation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'applied' AND NEW.applied_by IS NULL THEN
    RAISE EXCEPTION 'An assistant request cannot be applied without a person recorded against it';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'applied' THEN
    NEW.applied_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assistant_confirmation ON assistant_requests;
CREATE TRIGGER trg_assistant_confirmation
  BEFORE UPDATE ON assistant_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_assistant_confirmation();


-- ── Row level security ──────────────────────────────────────
ALTER TABLE assistant_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON assistant_requests FROM anon;

DROP POLICY IF EXISTS "Staff read assistant requests"  ON assistant_requests;
DROP POLICY IF EXISTS "Owner write assistant requests" ON assistant_requests;

CREATE POLICY "Staff read assistant requests" ON assistant_requests FOR SELECT
  USING (current_user_role() IN ('owner','staff'));

-- Writing is done by the function using the service key, which
-- bypasses RLS by design — the function checks the role itself
-- before it does anything. No policy grants a browser session
-- direct write access to this table, so the confirm step cannot
-- be skipped by calling the database straight from the page.


-- ============================================================
-- After running this:
--
-- 1. Open the admin, Sourcing -> Ask. Type something ordinary,
--    like "add example.com as a competitor called Example".
-- 2. Read the proposal. Press the button, or do not.
-- 3. Everything asked and everything applied is listed
--    underneath, oldest at the bottom.
--
-- If ANTHROPIC_API_KEY is not set, the box still works for
-- straightforward phrasings through the built-in parser, and
-- says plainly when it has not understood rather than guessing.
-- ============================================================
