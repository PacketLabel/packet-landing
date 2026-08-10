-- ============================================================
-- Packet — Migration 001: Base schema
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Packet is a pre-launch shop. There is no catalogue and no
-- checkout here on purpose: Shopify owns products, cart, payment
-- and tax, so the kit's place_order RPC and catalogue tables are
-- deliberately NOT carried over. What this holds is the pre-launch
-- audience — who signed up, what they told us, and what codes we
-- have promised.
--
-- Run order: 001 -> 002 -> 003. Run 001 first and read the output.
-- ============================================================

-- ── shared trigger helper ───────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ── app_settings ────────────────────────────────────────────
-- Kit convention: anything the business might change lives here,
-- never as a constant in a page. Changing discount_terms changes
-- what Packet has publicly promised, so it is owner-only in 002.
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text        NOT NULL DEFAULT '',
  note        text,
  is_public   boolean     NOT NULL DEFAULT false,  -- readable by the anon key
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- >>> CUSTOMISE: the discount terms are a public promise. Agreed by
-- both shareholders 7 August 2026. Setting discount_terms to
-- 'TERMS NOT SET' or an empty string stops any code being issued.
INSERT INTO app_settings (key, value, note, is_public) VALUES
  ('assessment_live',  'false',
   'Master switch. While false the assessment page says it is not running and stores nothing.', true),
  ('discount_percent', '10',
   'Percentage off. Shown on the pages and printed on the code.', true),
  ('discount_terms',
   '10% off your first order. One code per person, for a single order, and not to be used alongside another offer. No minimum spend. Valid for 12 months from the day we open. If you send something back that was bought with the code, we refund what you actually paid for it.',
   'Shown to the visitor verbatim — this IS the promise.', true),
  ('code_prefix',      'PKT',
   'Leading characters of every issued discount code.', true),
  ('assessment_intro', 'Five quick questions about what you actually spend. Under a minute.',
   'Sub-heading on the assessment page.', true),
  ('brand_voice',
   'Warm, plain, UK English. Never claim a product does anything to skin or hair. Never imply how many people work at Packet. Never suggest Packet is undecided or waiting to be told what to sell. Never hand someone a reason not to buy.',
   'Used by the social studio as the system prompt. Editing this changes every draft.', false)
ON CONFLICT (key) DO NOTHING;


-- ── subscribers ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscribers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL,
  consent_marketing  boolean     NOT NULL DEFAULT false,
  -- The exact wording shown next to the tick box at the moment of
  -- signup. This is the consent evidence: if the wording changes
  -- later, old rows still record what that person actually agreed to.
  consent_text       text        NOT NULL,
  consent_at         timestamptz,
  source             text        NOT NULL DEFAULT 'landing',
  utm_source         text,
  utm_medium         text,
  utm_campaign       text,
  unsubscribe_token  uuid        NOT NULL DEFAULT gen_random_uuid(),
  unsubscribed_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness. Also the conflict target used by subscribe().
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_email_lower_key
  ON subscribers (lower(email));
CREATE INDEX IF NOT EXISTS subscribers_created_at_idx
  ON subscribers (created_at DESC);

DROP TRIGGER IF EXISTS trg_subscribers_updated_at ON subscribers;
CREATE TRIGGER trg_subscribers_updated_at
  BEFORE UPDATE ON subscribers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── assessments ─────────────────────────────────────────────
-- One row per completion. Answers are jsonb so a question can be
-- added or reworded without a migration, and without silently
-- changing what older rows mean.
CREATE TABLE IF NOT EXISTS assessments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text        NOT NULL,
  answers           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  discount_code     text        NOT NULL UNIQUE,
  code_redeemed_at  timestamptz,
  consent_marketing boolean     NOT NULL DEFAULT false,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assessments_created_at_idx
  ON assessments (created_at DESC);
CREATE INDEX IF NOT EXISTS assessments_email_lower_idx
  ON assessments (lower(email));


-- ── page_views ──────────────────────────────────────────────
-- Deliberately holds nothing that identifies a person: no IP, no
-- cookie, no device or browser fingerprint, no localStorage. That
-- is what keeps this outside the PECR cookie rules and means the
-- site needs no cookie banner. Do not add an IP column without
-- taking advice.
CREATE TABLE IF NOT EXISTS page_views (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path         text        NOT NULL,
  referrer     text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_views_created_at_idx
  ON page_views (created_at DESC);


-- ── social_posts ────────────────────────────────────────────
-- Drafts produced by the social studio in the admin app. Kept so a
-- draft survives a page refresh, and so previous posts can be fed
-- back as voice examples rather than the tone drifting every time.
CREATE TABLE IF NOT EXISTS social_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text        NOT NULL DEFAULT 'instagram'
              CHECK (channel IN ('instagram','facebook','tiktok','email','other')),
  brief       text,                      -- the rough notes it was drafted from
  body        text        NOT NULL,      -- the draft itself
  hashtags    text,
  status      text        NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','approved','posted','discarded')),
  ai_used     boolean     NOT NULL DEFAULT false,  -- false when the fallback template was used
  posted_at   timestamptz,
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_posts_created_at_idx
  ON social_posts (created_at DESC);

DROP TRIGGER IF EXISTS trg_social_posts_updated_at ON social_posts;
CREATE TRIGGER trg_social_posts_updated_at
  BEFORE UPDATE ON social_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Next: 002_roles_and_rls.sql. Do not stop here — until 002 runs,
-- these tables have no row level security on them.
-- ============================================================
