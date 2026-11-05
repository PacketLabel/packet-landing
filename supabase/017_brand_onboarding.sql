-- ============================================================
-- Packet — Migration 017: onboarding any brand, at any time
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 4 November 2026.
--
-- Until now every Outlet brand was set up by hand: added on the
-- Brands page, terms typed in, a login made with a password sent
-- separately, and (for Shopify brands) an app made in Shopify's Dev
-- Dashboard. Fine for one brand. Not for twenty, and not for a
-- brand that says yes on a Saturday.
--
-- This makes the whole journey a path the brand walks themselves,
-- with Packet deciding at two points only — whether to take them,
-- and on what terms:
--
--   1. APPLY      apply.html, no login. Lands in brand_applications.
--                 Or Packet invites a brand directly from the admin,
--                 which makes the same row with source 'invited'.
--   2. APPROVE    Packet sets the commission offered (and, if wanted,
--                 the normal Outlet discount and whether their stock
--                 lists itself). A login is made and the brand is
--                 emailed a link to set their password.
--   3. SET UP     In their own login the brand fills in their
--                 business details, reads and accepts the Outlet
--                 terms online, and chooses how stock reaches us:
--                 their Shopify, their WooCommerce, an export file
--                 from any other shop, a spreadsheet, or by hand.
--   4. SELL       Nothing goes on sale until the terms are agreed.
--
-- Rules carried over and not softened:
--   * There is still no seeded commission and no seeded discount.
--     Both are NULL until a person types a number.
--   * The terms text is seeded as a DRAFT that cannot be accepted.
--     Only an owner can publish a version, and the seed says on its
--     face that a solicitor must check it first.
--   * A brand outside Great Britain cannot go live until an owner
--     has ticked that the cross-border questions (customs, duty,
--     returns) are settled for them. Packet is the seller in law.
--   * Beauty still needs the UK Responsible Person confirmation (014).
--
-- None of this is legal advice. The terms, the data sharing and the
-- cross-border points are input for a solicitor or accountant.
--
-- Safe to run twice. Run order: ... -> 015 -> 016 -> 017.
-- ============================================================


-- ── 1. Applications ──────────────────────────────────────────
-- Written only by netlify-functions/brand-onboard.js using the
-- service key. The public page never touches the database directly,
-- in keeping with the rest of the site (see README, Security model).
CREATE TABLE IF NOT EXISTS brand_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  company_name    text NOT NULL CHECK (length(btrim(company_name)) BETWEEN 1 AND 200),
  website         text NOT NULL CHECK (website ~* '^https?://[^ ]+\.[^ ]+'),
  contact_name    text NOT NULL CHECK (length(btrim(contact_name)) BETWEEN 1 AND 120),
  contact_email   text NOT NULL CHECK (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone   text,
  country         text NOT NULL DEFAULT 'GB' CHECK (country ~ '^[A-Z]{2}$'),

  -- What their own shop runs on. Decides which way of connecting
  -- their stock the setup page offers first.
  platform        text NOT NULL DEFAULT 'other'
                    CHECK (platform IN ('shopify','woocommerce','wix','squarespace',
                                        'bigcommerce','etsy','other','none')),

  categories      text[] NOT NULL DEFAULT '{}',
  -- returns, end_of_season, samples, seconds, damaged_packaging, overstock
  stock_kinds     text[] NOT NULL DEFAULT '{}',
  approx_units    text,
  instagram_handle text,
  message         text CHECK (message IS NULL OR length(message) <= 3000),

  -- Beauty and anything applied to the body: do they hold the UK
  -- Responsible Person role? Asked up front so nobody is approved
  -- into a category they cannot sell in.
  uk_rp           text NOT NULL DEFAULT 'n_a' CHECK (uk_rp IN ('yes','no','n_a','unknown')),

  --   new       waiting for Packet
  --   approved  a brand row and a login exist (brand_id)
  --   declined  Packet said no (decline_reason)
  --   spam      not a brand
  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','approved','declined','spam')),
  -- 'apply page' or 'invited by <email>'
  source          text NOT NULL DEFAULT 'apply page',

  brand_id        uuid REFERENCES brands(id) ON DELETE SET NULL,
  decline_reason  text,
  reviewed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_applications_status_idx ON brand_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS brand_applications_email_idx  ON brand_applications (lower(contact_email), created_at DESC);

ALTER TABLE brand_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brand_applications FROM anon;
DROP POLICY IF EXISTS "Staff read applications"   ON brand_applications;
DROP POLICY IF EXISTS "Staff update applications" ON brand_applications;
DROP POLICY IF EXISTS "Owner delete applications" ON brand_applications;
CREATE POLICY "Staff read applications" ON brand_applications FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
CREATE POLICY "Staff update applications" ON brand_applications FOR UPDATE
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));
CREATE POLICY "Owner delete applications" ON brand_applications FOR DELETE
  USING (current_user_role() = 'owner');


-- ── 2. What a brand row needs to know about the business ─────
-- found_via gains 'application'. The constraint name is whatever
-- Postgres chose in 013, so find it rather than guess it.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.brands'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%found_via%'
  LOOP EXECUTE format('ALTER TABLE brands DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE brands ADD CONSTRAINT brands_found_via_check
  CHECK (found_via IS NULL OR found_via IN ('discovery','instagram','search','competitor',
                                            'high-street','faire','personal','other','application'));

-- Filled in by the brand on their setup page (brand_save_details).
ALTER TABLE brands ADD COLUMN IF NOT EXISTS legal_name       text;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS company_number   text;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS country          text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
ALTER TABLE brands ADD COLUMN IF NOT EXISTS business_phone   text;
-- Where a customer's return goes. Packet is the seller, so the
-- customer contacts Packet; Packet hands them this address.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS returns_address  text;
-- How many working days the brand takes to post an order.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS dispatch_days    int CHECK (dispatch_days IS NULL OR dispatch_days BETWEEN 1 AND 10);
ALTER TABLE brands ADD COLUMN IF NOT EXISTS details_done_at  timestamptz;

-- Brands already marked UK-based in 013 are GB.
UPDATE brands SET country = 'GB' WHERE country IS NULL AND uk_based = 'yes';

-- Set by Packet when approving. Becomes outlet_commission_pct (014)
-- only when the brand accepts the terms online, or when Packet records
-- an agreement made some other way. The offer is not the agreement.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_commission_offered_pct numeric
  CHECK (outlet_commission_offered_pct IS NULL OR (outlet_commission_offered_pct >= 0 AND outlet_commission_offered_pct <= 100));
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_terms_version text;

-- Packet's normal Outlet price for this brand: this % off their
-- normal price, never below their lowest. NULL = Packet prices every
-- item by hand. Falls back to the app setting outlet_default_discount_pct.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_discount_pct numeric
  CHECK (outlet_discount_pct IS NULL OR (outlet_discount_pct >= 0 AND outlet_discount_pct < 100));
-- A brand Packet trusts: items they send go on sale straight away at
-- the normal Outlet price, without waiting for someone to look. Items
-- with a fault, worn items, and items with no photo still wait.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_auto_list boolean NOT NULL DEFAULT false;

-- Outside Great Britain: customs, duty and returns need settling for
-- this brand before anything goes on sale. Ticked by an owner.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS cross_border_ok boolean NOT NULL DEFAULT false;

-- The brand's own page in the shop: /collections/outlet-<handle>
ALTER TABLE brands ADD COLUMN IF NOT EXISTS shopify_collection_id text;

ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_invited_at timestamptz;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_login_email text;

-- A brand may not change any of Packet's columns above through the
-- table. They have no policy on brands at all (013); they write their
-- details through brand_save_details() below.

INSERT INTO app_settings (key, value, note) VALUES
  ('outlet_default_discount_pct', '',
   'Outlet: % off a brand''s normal price for the suggested Outlet price, when the brand has none of its own. Blank = always price by hand.'),
  ('outlet_notify_email', '',
   'Outlet: where new brand applications are emailed. Blank = the sender address.')
ON CONFLICT (key) DO NOTHING;


-- ── 3. The terms, in versions ────────────────────────────────
CREATE TABLE IF NOT EXISTS outlet_terms (
  version       text PRIMARY KEY CHECK (version ~ '^[A-Za-z0-9._-]{1,20}$'),
  title         text NOT NULL,
  body          text NOT NULL,
  -- NULL = draft. A brand can only accept a published version.
  published_at  timestamptz,
  published_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE outlet_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON outlet_terms FROM anon;
DROP POLICY IF EXISTS "Staff read terms"  ON outlet_terms;
DROP POLICY IF EXISTS "Owner write terms" ON outlet_terms;
CREATE POLICY "Staff read terms" ON outlet_terms FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
CREATE POLICY "Owner write terms" ON outlet_terms FOR ALL
  USING (current_user_role() = 'owner') WITH CHECK (current_user_role() = 'owner');

-- A published version is a record of what brands agreed to. It is
-- never edited — write a new version instead.
CREATE OR REPLACE FUNCTION outlet_terms_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'Version % has been published. It stays, so there is a record of what brands agreed to.', OLD.version;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'Version % has been published and cannot be changed. Save the new wording as a new version.', OLD.version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS outlet_terms_guard_trg ON outlet_terms;
CREATE TRIGGER outlet_terms_guard_trg BEFORE UPDATE OR DELETE ON outlet_terms
  FOR EACH ROW EXECUTE FUNCTION outlet_terms_guard();

-- The starting draft. Plain English, written to be read by a busy
-- brand owner. NOT checked by a solicitor — the first line says so,
-- and it cannot be accepted until an owner publishes it.
INSERT INTO outlet_terms (version, title, body) VALUES ('v1', 'Packet Outlet brand terms', $terms$
DRAFT — to be checked by a solicitor before it is published. Delete this line when it has been.

These terms are between Packet Label Limited (company number 17392293, "Packet", "we") and the business named on this page ("you"). They apply to everything you offer through Packet Outlet.

1. What Packet Outlet is
Packet Outlet sells your returns, end-of-season, sample and clearance stock to Packet's customers at outlet prices. You keep the stock and post each order direct to the customer. We never buy or hold your stock, and there is no minimum.

2. What you offer
You choose what to offer and the lowest price you will accept for each item. You describe each item's condition honestly, including any fault, and keep the number available up to date. If something sells on Packet that you no longer have, we will refund the customer and may pass on any cost of doing so.

3. Our price and our share
We set the Outlet price, never below your lowest price. When an item sells, Packet keeps the percentage shown on this page of the price the customer paid for the item, and you are owed the rest. Delivery charges paid by the customer are Packet's. A change to the percentage applies only to sales made after you have accepted it.

4. Posting
You post each order within the number of working days you have given us, to the address shown in your login, and add the tracking details. You pay for posting unless we agree otherwise in writing.

5. Being paid
We pay what you are owed for posted orders monthly in arrears, by bank transfer, once the customer's 30-day return window has passed. Your login shows each sale and payment.

6. Customers, returns and faults
Packet is the seller to the customer, so customers contact Packet. Change-of-mind returns go to the returns address you give us. If an item is returned or refunded, nothing is owed to you for it, and if you have already been paid for it we deduct it from your next payment. If the item did not match its description, you cover the cost of putting it right.

7. Customer details
We give you a customer's name and address only so you can post their order. You must not keep them for longer than you need to, or use them for anything else. Your login stops showing them 30 days after you mark the order posted.

8. Products that need extra checks
You confirm that what you offer is safe and lawful to sell in the UK. For anything applied to the body (cosmetics, skincare, haircare, fragrance, nails) you confirm that you hold the UK Responsible Person role and the product is notified on the UK cosmetics portal.

9. Your name and photos
You let us use your brand name, logo, product photos and descriptions to list and promote your items on Packet's website and social media while they are on offer.

10. Ending
Either of us can stop at any time by email. Orders already placed are still posted and paid for.

11. Law
These terms are governed by the law of England and Wales.
$terms$)
ON CONFLICT (version) DO NOTHING;


-- ── 4. Agreements ────────────────────────────────────────────
-- One row each time a brand accepts a version. A copy of the wording
-- and the percentage is kept on the row, so the record still says
-- exactly what was agreed if anything changes later.
CREATE TABLE IF NOT EXISTS brand_agreements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  version            text NOT NULL REFERENCES outlet_terms(version) ON DELETE RESTRICT,
  terms_title        text NOT NULL,
  terms_body         text NOT NULL,
  commission_pct     numeric NOT NULL,
  accepted_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_email     text,
  accepted_name      text NOT NULL,
  accepted_job_title text NOT NULL,
  user_agent         text,
  accepted_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_agreements_brand_idx ON brand_agreements (brand_id, accepted_at DESC);
ALTER TABLE brand_agreements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brand_agreements FROM anon;
DROP POLICY IF EXISTS "Staff read agreements" ON brand_agreements;
CREATE POLICY "Staff read agreements" ON brand_agreements FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
-- No insert, update or delete policy for anyone: rows arrive only
-- through brand_accept_terms(), and are never changed.


-- ── 5. What a brand can see and do about itself ──────────────
-- The latest published terms.
CREATE OR REPLACE FUNCTION outlet_current_terms()
RETURNS outlet_terms LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT * FROM outlet_terms WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION outlet_current_terms() FROM PUBLIC, anon, authenticated;

-- my_brand() from 014, with the setup steps added. Still a short list:
-- nothing here is Packet's private notes or pipeline.
DROP FUNCTION IF EXISTS my_brand();
CREATE FUNCTION my_brand()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  b brands%ROWTYPE;
  t outlet_terms%ROWTYPE;
  connected boolean;
  any_items boolean;
BEGIN
  SELECT * INTO b FROM brands WHERE id = current_brand_id();
  IF NOT FOUND THEN RETURN NULL; END IF;
  t := outlet_current_terms();
  SELECT EXISTS (SELECT 1 FROM brand_shops s WHERE s.brand_id = b.id AND s.status IN ('connected','error'))
    INTO connected;
  SELECT EXISTS (SELECT 1 FROM outlet_items i WHERE i.brand_id = b.id) INTO any_items;
  RETURN jsonb_build_object(
    'id',               b.id,
    'name',             b.name,
    'website',          b.website,
    'commission_pct',   b.outlet_commission_pct,
    'terms_agreed_at',  b.outlet_terms_agreed_at,
    'terms_version',    b.outlet_terms_version,
    'offered_pct',      COALESCE(b.outlet_commission_offered_pct, b.outlet_commission_pct),
    'legal_name',       b.legal_name,
    'company_number',   b.company_number,
    'country',          COALESCE(b.country, 'GB'),
    'business_phone',   b.business_phone,
    'returns_address',  b.returns_address,
    'dispatch_days',    b.dispatch_days,
    'details_done',     b.details_done_at IS NOT NULL,
    'cross_border_ok',  COALESCE(b.country, 'GB') = 'GB' OR b.cross_border_ok,
    'auto_list',        b.outlet_auto_list,
    'terms', CASE WHEN t.version IS NULL THEN NULL ELSE
             jsonb_build_object('version', t.version, 'title', t.title, 'body', t.body) END,
    -- Terms are needed when there is no agreement at all, or Packet has
    -- published a newer version than the one accepted online. A brand
    -- whose terms Packet recorded by hand (outlet_terms_version NULL,
    -- commission set) is not asked again.
    'terms_needed',     b.outlet_commission_pct IS NULL
                        OR (b.outlet_terms_version IS NOT NULL AND t.version IS NOT NULL
                            AND b.outlet_terms_version <> t.version),
    'stock_connected',  connected,
    'has_items',        any_items
  );
END;
$$;
REVOKE ALL ON FUNCTION my_brand() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_brand() TO authenticated;

-- The brand fills in its own business details. Only these columns.
CREATE OR REPLACE FUNCTION brand_save_details(p jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b uuid := current_brand_id();
  v_legal text   := left(btrim(COALESCE(p->>'legal_name', '')), 200);
  v_num text     := left(btrim(COALESCE(p->>'company_number', '')), 40);
  v_country text := upper(left(btrim(COALESCE(p->>'country', 'GB')), 2));
  v_phone text   := left(btrim(COALESCE(p->>'business_phone', '')), 40);
  v_ret text     := left(btrim(COALESCE(p->>'returns_address', '')), 600);
  v_days int;
  old_country text;
BEGIN
  IF b IS NULL THEN RAISE EXCEPTION 'Not a brand login.' USING ERRCODE = '42501'; END IF;
  IF v_legal = '' THEN RAISE EXCEPTION 'Put in your business''s legal name.' USING ERRCODE = '23514'; END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Choose the country you post from.' USING ERRCODE = '23514'; END IF;
  IF length(v_ret) < 10 THEN RAISE EXCEPTION 'Put in the full address returns should go to.' USING ERRCODE = '23514'; END IF;
  BEGIN v_days := (p->>'dispatch_days')::int;
  EXCEPTION WHEN OTHERS THEN v_days := NULL; END;
  IF v_days IS NULL OR v_days < 1 OR v_days > 10 THEN
    RAISE EXCEPTION 'Say how many working days you take to post an order (1 to 10).' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(country, 'GB') INTO old_country FROM brands WHERE id = b;
  UPDATE brands SET
    legal_name = v_legal, company_number = NULLIF(v_num, ''), country = v_country,
    business_phone = NULLIF(v_phone, ''), returns_address = v_ret, dispatch_days = v_days,
    details_done_at = COALESCE(details_done_at, now()),
    -- Moving to another country undoes Packet's cross-border tick.
    cross_border_ok = CASE WHEN v_country = old_country THEN cross_border_ok ELSE false END,
    uk_based = CASE WHEN v_country = 'GB' THEN 'yes' ELSE 'no' END,
    updated_at = now()
  WHERE id = b;
END;
$$;
REVOKE ALL ON FUNCTION brand_save_details(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_save_details(jsonb) TO authenticated;

-- The brand accepts the current terms online.
CREATE OR REPLACE FUNCTION brand_accept_terms(p_version text, p_name text, p_job_title text, p_user_agent text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b   brands%ROWTYPE;
  t   outlet_terms%ROWTYPE;
  pct numeric;
  who text;
BEGIN
  SELECT * INTO b FROM brands WHERE id = current_brand_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not a brand login.' USING ERRCODE = '42501'; END IF;
  t := outlet_current_terms();
  IF t.version IS NULL THEN
    RAISE EXCEPTION 'Packet has not published its terms yet. We will email you when they are ready.' USING ERRCODE = '23514';
  END IF;
  IF p_version IS DISTINCT FROM t.version THEN
    RAISE EXCEPTION 'The terms have been updated since this page opened. Please reload and read the new version.' USING ERRCODE = '23514';
  END IF;
  IF b.details_done_at IS NULL THEN
    RAISE EXCEPTION 'Fill in your business details first.' USING ERRCODE = '23514';
  END IF;
  pct := COALESCE(b.outlet_commission_offered_pct, b.outlet_commission_pct);
  IF pct IS NULL THEN
    RAISE EXCEPTION 'Packet has not set your percentage yet. Email info@packetlabel.com.' USING ERRCODE = '23514';
  END IF;
  IF length(btrim(COALESCE(p_name, ''))) < 2 OR length(btrim(COALESCE(p_job_title, ''))) < 2 THEN
    RAISE EXCEPTION 'Put in your full name and your job title.' USING ERRCODE = '23514';
  END IF;

  SELECT email INTO who FROM auth.users WHERE id = auth.uid();
  INSERT INTO brand_agreements (brand_id, version, terms_title, terms_body, commission_pct,
                                accepted_by, accepted_email, accepted_name, accepted_job_title, user_agent)
  VALUES (b.id, t.version, t.title, t.body, pct, auth.uid(), who,
          left(btrim(p_name), 120), left(btrim(p_job_title), 120), left(COALESCE(p_user_agent, ''), 400));

  UPDATE brands SET
    outlet_commission_pct  = pct,
    outlet_terms_version   = t.version,
    outlet_terms_agreed_at = current_date,
    outlet_terms_source    = 'Accepted online: terms ' || t.version || ', ' || pct || '%, by ' ||
                             left(btrim(p_name), 120) || ' (' || left(btrim(p_job_title), 120) || '), ' ||
                             to_char(now() AT TIME ZONE 'Europe/London', 'FMDD Mon YYYY HH24:MI'),
    updated_at = now()
  WHERE id = b.id;

  RETURN jsonb_build_object('ok', true, 'commission_pct', pct, 'version', t.version);
END;
$$;
REVOKE ALL ON FUNCTION brand_accept_terms(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_accept_terms(text, text, text, text) TO authenticated;


-- ── 6. Pricing that scales past a handful of brands ──────────
-- The suggested Outlet price: discount % off the normal price,
-- rounded down to the 50p, never below the brand's lowest. With no
-- normal price, the lowest price is the suggestion.
CREATE OR REPLACE FUNCTION outlet_suggest_minor(p_rrp int, p_floor int, p_discount numeric)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_discount IS NULL THEN NULL
    WHEN p_rrp IS NULL THEN p_floor
    ELSE GREATEST(p_floor, (floor(p_rrp * (100 - p_discount) / 100 / 50) * 50)::int)
  END;
$$;

CREATE OR REPLACE FUNCTION outlet_discount_for(p_brand uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT outlet_discount_pct FROM brands WHERE id = p_brand),
    (SELECT NULLIF(btrim(value), '')::numeric FROM app_settings WHERE key = 'outlet_default_discount_pct'
      AND btrim(value) ~ '^\d+(\.\d+)?$')
  );
$$;
REVOKE ALL ON FUNCTION outlet_discount_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION outlet_discount_for(uuid) TO authenticated;

-- Runs after 014's guard (names fire in alphabetical order:
-- guard < q_ready < source_guard < zy < zz), so whatever a brand was
-- allowed to send has already been decided.
-- SECURITY DEFINER because a brand login cannot read the brands
-- table, and this has to see the brand's terms to decide.
CREATE OR REPLACE FUNCTION outlet_items_ready()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b brands%ROWTYPE;
  disc numeric;
  becoming_live boolean;
BEGIN
  SELECT * INTO b FROM brands WHERE id = NEW.brand_id;

  -- Lists itself: a trusted brand, a normal price set, and nothing a
  -- person ought to look at first.
  IF NEW.status = 'submitted'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'submitted' OR OLD.quantity = 0)
     AND b.outlet_auto_list
     AND b.outlet_commission_pct IS NOT NULL
     AND (COALESCE(b.country, 'GB') = 'GB' OR b.cross_border_ok)
     AND NEW.quantity > 0
     AND NEW.condition NOT IN ('returned_worn','minor_fault')
     AND (NEW.condition <> 'box_damaged' OR COALESCE(btrim(NEW.condition_note), '') <> '')
     AND jsonb_array_length(NEW.photos) > 0
     AND (NEW.category <> 'beauty' OR NEW.uk_rp_confirmed)
  THEN
    disc := outlet_discount_for(NEW.brand_id);
    IF disc IS NOT NULL THEN
      NEW.sale_minor  := COALESCE(NEW.sale_minor, outlet_suggest_minor(NEW.rrp_minor, NEW.floor_minor, disc));
      NEW.status      := 'live';
      NEW.packet_note := NULL;
    END IF;
  END IF;

  becoming_live := NEW.status = 'live' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'live');
  IF becoming_live THEN
    IF b.outlet_commission_pct IS NULL THEN
      RAISE EXCEPTION 'Nothing from % can go on sale until their terms are agreed.', b.name USING ERRCODE = '23514';
    END IF;
    IF COALESCE(b.country, 'GB') <> 'GB' AND NOT b.cross_border_ok THEN
      RAISE EXCEPTION '% posts from outside Great Britain. Tick "cross-border settled" on their Outlet settings before anything goes on sale.', b.name
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS outlet_items_q_ready_trg ON outlet_items;
CREATE TRIGGER outlet_items_q_ready_trg BEFORE INSERT OR UPDATE ON outlet_items
  FOR EACH ROW EXECUTE FUNCTION outlet_items_ready();

-- Staff: put many waiting items on sale at once, each at its
-- suggested price. Skips (and says why) anything that cannot go.
CREATE OR REPLACE FUNCTION outlet_list_at_suggested(p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  it outlet_items%ROWTYPE;
  disc numeric;
  done int := 0;
  skipped jsonb := '[]'::jsonb;
BEGIN
  IF current_user_role() NOT IN ('owner','staff') THEN RAISE EXCEPTION 'Packet staff only.' USING ERRCODE = '42501'; END IF;
  FOR it IN SELECT * FROM outlet_items WHERE id = ANY(p_ids) AND status IN ('submitted','paused') LOOP
    disc := outlet_discount_for(it.brand_id);
    IF disc IS NULL THEN
      skipped := skipped || jsonb_build_object('id', it.id, 'title', it.title, 'why', 'no normal Outlet discount set for this brand');
      CONTINUE;
    END IF;
    BEGIN
      UPDATE outlet_items SET sale_minor = outlet_suggest_minor(it.rrp_minor, it.floor_minor, disc),
                              status = 'live', packet_note = NULL
       WHERE id = it.id;
      done := done + 1;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped || jsonb_build_object('id', it.id, 'title', it.title, 'why', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('listed', done, 'skipped', skipped);
END;
$$;
REVOKE ALL ON FUNCTION outlet_list_at_suggested(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION outlet_list_at_suggested(uuid[]) TO authenticated;


-- ── 7. Shop links beyond Shopify ─────────────────────────────
-- brand_shops (016) was Shopify only. WooCommerce joins it: the brand
-- presses Connect, approves Packet in their own WordPress, and
-- WooCommerce hands over a key. Brands on anything else (Wix,
-- Squarespace, Etsy, BigCommerce...) upload their shop's own product
-- export file instead — no link needed, see packet-outlet.js.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.brand_shops'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%platform%' OR pg_get_constraintdef(oid) ILIKE '%myshopify%')
  LOOP EXECUTE format('ALTER TABLE brand_shops DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE brand_shops ALTER COLUMN shop_domain DROP NOT NULL;
ALTER TABLE brand_shops ADD COLUMN IF NOT EXISTS site_url        text;
ALTER TABLE brand_shops ADD COLUMN IF NOT EXISTS consumer_key    text;
ALTER TABLE brand_shops ADD COLUMN IF NOT EXISTS consumer_secret text;
-- 'oauth' (an install link) or 'client_credentials' (the brand made the
-- app in their own Shopify, so Packet can ask for a key directly).
ALTER TABLE brand_shops ADD COLUMN IF NOT EXISTS token_grant     text;
-- The brand asked Packet to make the Shopify app for them.
ALTER TABLE brand_shops ADD COLUMN IF NOT EXISTS needs_packet_app boolean NOT NULL DEFAULT false;

ALTER TABLE brand_shops ADD CONSTRAINT brand_shops_platform_check
  CHECK (platform IN ('shopify','woocommerce'));
ALTER TABLE brand_shops ADD CONSTRAINT brand_shops_address_check
  CHECK ((platform = 'shopify'     AND shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$')
      OR (platform = 'woocommerce' AND site_url ~ '^https://[a-z0-9.-]+(:[0-9]+)?(/[^ ]*)?$'));
CREATE UNIQUE INDEX IF NOT EXISTS brand_shops_site_url_uq ON brand_shops (lower(site_url)) WHERE site_url IS NOT NULL;

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.outlet_items'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%source%' AND pg_get_constraintdef(oid) ILIKE '%packet%'
  LOOP EXECUTE format('ALTER TABLE outlet_items DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE outlet_items ADD CONSTRAINT outlet_items_source_ok CHECK (source IN ('packet','shopify','woocommerce'));

DROP FUNCTION IF EXISTS brand_shop_status();
CREATE FUNCTION brand_shop_status()
RETURNS TABLE (
  brand_id uuid, platform text, shop_domain text, site_url text, status text, outlet_tag text,
  default_condition text, default_category text, lowest_pct int,
  connected_at timestamptz, last_sync_at timestamptz, last_error text,
  last_warnings jsonb, items_linked int, own_app boolean, needs_packet_app boolean
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT s.brand_id, s.platform, s.shop_domain, s.site_url, s.status, s.outlet_tag,
         s.default_condition, s.default_category, s.lowest_pct,
         s.connected_at, s.last_sync_at, s.last_error,
         s.last_warnings, s.items_linked, (s.client_id IS NOT NULL), s.needs_packet_app
    FROM brand_shops s
   WHERE (current_user_role() = 'brand' AND s.brand_id = current_brand_id())
      OR current_user_role() IN ('owner','staff') AND auth.uid() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION brand_shop_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_shop_status() TO authenticated;


-- ── 8. The staff view of every brand's progress ─────────────
DROP VIEW IF EXISTS outlet_brand_summary;
CREATE VIEW outlet_brand_summary
WITH (security_invoker = true) AS
SELECT
  b.id AS brand_id,
  b.name,
  b.outlet_commission_pct,
  b.outlet_terms_agreed_at,
  count(DISTINCT i.id) FILTER (WHERE i.status = 'submitted') AS n_waiting,
  count(DISTINCT i.id) FILTER (WHERE i.status = 'live')      AS n_live,
  COALESCE(sum(i.quantity) FILTER (WHERE i.status = 'live'), 0) AS units_live,
  b.outlet_commission_offered_pct,
  b.outlet_terms_version,
  b.outlet_discount_pct,
  b.outlet_auto_list,
  COALESCE(b.country, 'GB') AS country,
  b.cross_border_ok,
  b.details_done_at,
  b.dispatch_days,
  b.outlet_invited_at,
  b.outlet_login_email,
  count(DISTINCT i.id) AS n_items
FROM brands b
LEFT JOIN outlet_items i ON i.brand_id = b.id
GROUP BY b.id;


-- ============================================================
-- After running this:
--   1. Deploy as usual. apply.html arrives with the admin site.
--   2. Outlet page → Terms: have the v1 draft checked, edit it, and
--      press Publish. Until then brands can set up everything except
--      accepting the terms, so nothing of theirs can go on sale.
--   3. Optional: Outlet page → Settings, set the normal Outlet
--      discount. Blank means every item is priced by hand.
-- ============================================================
