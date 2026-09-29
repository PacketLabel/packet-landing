-- ============================================================
-- Packet — Migration 014: The Outlet brand login
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 29 September 2026.
--
-- Packet Outlet sells brands' returns, end-of-season and
-- damaged-box stock. The brand keeps the stock and ships it; Packet
-- lists it, takes the payment and keeps an agreed percentage.
--
-- Shopify Collective (013) does this for brands whose own shop is
-- on Shopify. This migration is Packet's own route, which works for
-- ANY brand whatever their shop runs on, and which knows things
-- Collective does not: condition grades, one-off sizes, a lowest
-- price the brand will accept, and an end date.
--
-- A brand gets a login. With it they can:
--   - add the stock they want Packet to sell
--   - see what has sold, with the delivery address
--   - enter the tracking number once it has gone
--   - see what Packet owes them and what has been paid
-- They see their own rows and nothing else — not another brand, not
-- the subscriber list, not Packet's sourcing, not Packet's notes
-- about them on the Brands page.
--
-- ── A SETTLED DECISION THIS TOUCHES ─────────────────────────
-- Decision 3 says Supabase must never become a second editable
-- product catalogue; Shopify owns products. outlet_items is a list
-- of products in Supabase, so it needs saying plainly what it is:
--
--   It is the brand's STOCK OFFER — what they are offering Packet,
--   at what lowest price, in what condition. It is where stock
--   waits before a Shopify shop exists, and where the brand keeps
--   quantity and lowest price up to date afterwards.
--
--   Once the Shopify shop exists, a live item is created in Shopify
--   and shopify_product_id is filled in. From then on what the
--   CUSTOMER sees (title, photos, price on the shop) is Shopify's,
--   and nobody edits it here. That keeps the spirit of Decision 3:
--   one place for what the customer sees.
--
--   Phil and Scott should agree this in writing as an amendment to
--   Decision 3 rather than let it drift in.
--
-- ── MONEY ───────────────────────────────────────────────────
-- Every price is in pence, VAT-inclusive, as the customer pays it.
-- There is no seeded commission. A brand's percentage is NULL until
-- it has been agreed in writing and typed in with where it came
-- from. While it is NULL the brand's payout on an order shows as
-- "terms not agreed" rather than as a guessed figure.
--
-- ── THE HOLE THIS ALSO CLOSES ───────────────────────────────
-- Five existing views (009, 010, 012, 013) were created without
-- security_invoker. A view like that reads its tables as the
-- database owner, which skips row level security — so ANY signed-in
-- account could read them. While the only logins were Phil and
-- Scott that did not matter. The first brand login would have been
-- able to read Packet's supplier cost prices. Section 6 fixes it.
--
-- Safe to run twice. Run order: ... -> 012 -> 013 -> 014.
-- ============================================================


-- ── 1. A 'brand' role, and which brand a login belongs to ────
-- The role list is a CHECK constraint from 002. Its name is whatever
-- Postgres chose, so find it rather than guess it.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.user_profiles'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE user_profiles DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('owner','staff','supplier','customer','brand'));

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brands(id) ON DELETE RESTRICT;
-- RESTRICT, not SET NULL: a brand that still has a login cannot be
-- deleted from the Brands page. Remove the login first (Outlet page).
-- SET NULL would break the rule below and leave an orphaned login.

-- A brand login must point at a brand, and only a brand login may.
-- Without this a mistyped update could leave a brand role floating
-- with no brand (sees nothing — harmless) or, worse, a staff login
-- carrying a brand_id that some later policy trusts.
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_brand_link_check;
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_brand_link_check
  CHECK ((role = 'brand') = (brand_id IS NOT NULL));


-- ── 2. The role helper, made safe for brand logins ───────────
-- 002's helper falls back to 'staff' when a login has no profile row.
-- That was least privilege when the only logins were Phil and Scott.
-- It is not now: a brand login whose profile row failed to write would
-- have been treated as staff and seen everything.
--
-- manage-users.js stamps every brand login with packet_role = 'brand'
-- in its app metadata, which only the service key can set — a brand
-- cannot change it about themselves. If the profile row is missing,
-- that stamp decides. Existing logins carry no stamp, so for them
-- nothing changes.
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT role FROM user_profiles WHERE id = auth.uid()),
    CASE WHEN (auth.jwt() -> 'app_metadata' ->> 'packet_role') = 'brand' THEN 'brand' END,
    'staff'
  );
$$;

-- The brand this login belongs to, or NULL for everyone else.
CREATE OR REPLACE FUNCTION current_brand_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT brand_id FROM user_profiles WHERE id = auth.uid() AND role = 'brand';
$$;
REVOKE ALL ON FUNCTION current_brand_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION current_brand_id() TO authenticated;

-- The new-login trigger from 002, taught to read the same stamp, so
-- a brand login is a brand from the very first instant rather than
-- being created as staff and changed a moment later.
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  is_brand boolean := COALESCE(NEW.raw_app_meta_data->>'packet_role', '') = 'brand';
BEGIN
  IF is_brand THEN
    INSERT INTO user_profiles (id, full_name, role, brand_id)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
            'brand', NULLIF(NEW.raw_app_meta_data->>'brand_id', '')::uuid)
    ON CONFLICT (id) DO NOTHING;
  ELSE
    INSERT INTO user_profiles (id, full_name)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Same rule as 002: never fail the login because of the profile.
  -- For a brand login the stamp in current_user_role() still holds
  -- the line, and manage-users.js writes the row straight after.
  RAISE WARNING 'create_user_profile failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;


-- ── 3. Terms on the brand ────────────────────────────────────
-- NULL until agreed in writing. margin_source in 013 is the model:
-- the evidence, in words.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_commission_pct numeric
  CHECK (outlet_commission_pct IS NULL OR (outlet_commission_pct >= 0 AND outlet_commission_pct <= 100));
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_terms_source    text;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS outlet_terms_agreed_at date;

-- What a brand login may know about its own brand. Deliberately a
-- short list: the brands row also holds Packet's private notes, the
-- pipeline status and the margin conversation, none of which is the
-- brand's business.
CREATE OR REPLACE FUNCTION my_brand()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id',             b.id,
    'name',           b.name,
    'commission_pct', b.outlet_commission_pct,
    'terms_agreed_at', b.outlet_terms_agreed_at
  )
  FROM brands b
  WHERE b.id = current_brand_id();
$$;
REVOKE ALL ON FUNCTION my_brand() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_brand() TO authenticated;


-- ── 4. Stock the brand offers ────────────────────────────────
CREATE TABLE IF NOT EXISTS outlet_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

  title           text NOT NULL CHECK (length(btrim(title)) > 0),
  description     text,

  -- A fixed list, not category_settings: brands should not be able to
  -- add categories to Packet's sourcing tool, and this is what a
  -- shopper browses by.
  category        text NOT NULL DEFAULT 'clothing'
                    CHECK (category IN ('clothing','footwear','accessories','jewellery',
                                        'beauty','home','kids','pets','other')),

  brand_sku       text,        -- the brand's own code, so they can find it in their warehouse
  size            text,
  colour          text,

  -- The thing an outlet has to be honest about, and Collective has no
  -- field for. Packet is the seller in law, so the listing must match
  -- what arrives.
  condition       text NOT NULL
                    CHECK (condition IN ('new_with_tags','new_no_tags','returned_as_new',
                                         'returned_worn','box_damaged','minor_fault')),
  condition_note  text,        -- required in the page for the last three

  quantity        int  NOT NULL DEFAULT 1 CHECK (quantity >= 0),

  -- The brand's normal full price, if they sell it themselves.
  rrp_minor       int  CHECK (rrp_minor IS NULL OR rrp_minor > 0),
  -- The lowest price the customer may pay. The brand's line in the sand.
  floor_minor     int  NOT NULL CHECK (floor_minor > 0),
  -- Packet's Outlet price. Set by Packet, never by the brand.
  sale_minor      int  CHECK (sale_minor IS NULL OR sale_minor > 0),

  -- Links to the photos. Uploaded ones live in the outlet-photos
  -- bucket; a brand may also paste links from their own site.
  photos          jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(photos) = 'array'),

  -- For anything applied to the body. Packet is the seller in law, and
  -- a cosmetic needs a UK Responsible Person. The version that works is
  -- a UK brand who already holds that role; this is the brand saying
  -- so. It cannot go live without it (see the guard below).
  uk_rp_confirmed boolean NOT NULL DEFAULT false,

  available_until date,

  --   draft      the brand is still filling it in
  --   submitted  the brand says it is ready; waiting for Packet
  --   live       Packet has approved it and priced it
  --   paused     Packet has taken it down for now
  --   withdrawn  the brand has taken it back
  --   rejected   Packet will not list it; packet_note says why
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','submitted','live','paused','withdrawn','rejected')),

  packet_note     text,        -- Packet's message to the brand, shown on their screen

  shopify_product_id text,     -- filled in once the Shopify shop exists

  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outlet_items_sale_above_floor CHECK (sale_minor IS NULL OR sale_minor >= floor_minor),
  CONSTRAINT outlet_items_live_is_priced   CHECK (status <> 'live' OR sale_minor IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS outlet_items_brand_idx  ON outlet_items (brand_id, status);
CREATE INDEX IF NOT EXISTS outlet_items_status_idx ON outlet_items (status, updated_at DESC);


-- ── The guard ────────────────────────────────────────────────
-- Row level security decides WHICH rows a brand can touch. It cannot
-- decide which COLUMNS, so this does: a brand can describe its stock
-- and set its lowest price, and cannot price it, approve it, or move
-- it to another brand. Doing this in the database rather than the
-- page means a brand with the browser console open gets the same
-- answer as one using the form.
CREATE OR REPLACE FUNCTION outlet_items_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  who text := current_user_role();
BEGIN
  NEW.updated_at := now();

  IF who = 'brand' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.brand_id           := current_brand_id();
      NEW.sale_minor         := NULL;
      NEW.packet_note        := NULL;
      NEW.shopify_product_id := NULL;
      NEW.created_by         := auth.uid();
      IF NEW.status NOT IN ('draft','submitted') THEN NEW.status := 'draft'; END IF;
    ELSE
      NEW.brand_id           := OLD.brand_id;
      NEW.sale_minor         := OLD.sale_minor;
      NEW.packet_note        := OLD.packet_note;
      NEW.shopify_product_id := OLD.shopify_product_id;
      NEW.created_by         := OLD.created_by;
      NEW.created_at         := OLD.created_at;

      IF NEW.status IS DISTINCT FROM OLD.status THEN
        -- A brand can always take its stock back, and can move its own
        -- work between draft and ready. Everything else is Packet's.
        IF NEW.status NOT IN ('draft','submitted','withdrawn') THEN
          RAISE EXCEPTION 'Only Packet can put an item live, pause it or turn it down.'
            USING ERRCODE = '42501';
        END IF;
        -- Editing a live item back to draft would quietly unlist it
        -- mid-sale. Withdraw is the honest version of that.
        IF OLD.status IN ('live','paused') AND NEW.status <> 'withdrawn' THEN
          RAISE EXCEPTION 'This item is on sale. To take it down, withdraw it.'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      -- Raising the lowest price above what it is on sale for would
      -- break the promise either way round. Say so in words.
      IF NEW.sale_minor IS NOT NULL AND NEW.floor_minor > NEW.sale_minor THEN
        RAISE EXCEPTION 'That lowest price is above the £% it is on sale for. Ask Packet to change the price, or withdraw it.',
          to_char(NEW.sale_minor / 100.0, 'FM999990.00')
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- For everyone, Packet included: nothing applied to the body goes
  -- live without the brand confirming it holds the UK Responsible
  -- Person role for it.
  IF NEW.status = 'live' AND NEW.category = 'beauty' AND NOT NEW.uk_rp_confirmed THEN
    RAISE EXCEPTION 'A beauty item cannot go live until the brand confirms it holds the UK Responsible Person role for it.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outlet_items_guard_trg ON outlet_items;
CREATE TRIGGER outlet_items_guard_trg BEFORE INSERT OR UPDATE ON outlet_items
  FOR EACH ROW EXECUTE FUNCTION outlet_items_guard();


-- ── 5. Orders ────────────────────────────────────────────────
-- One row per item sold. Until the Shopify shop exists these are
-- entered by hand — mostly test orders, so a brand can be shown the
-- whole thing working. Once the shop exists, Shopify's order
-- notification writes them instead.
CREATE TABLE IF NOT EXISTS outlet_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  item_id         uuid REFERENCES outlet_items(id) ON DELETE SET NULL,

  -- A copy of what was sold, taken at the time. If the item is edited
  -- or deleted later the order still says what the customer bought.
  item_title      text NOT NULL,
  item_size       text,
  item_colour     text,
  item_condition  text,
  item_brand_sku  text,

  order_ref       text NOT NULL,   -- Packet's order number
  quantity        int  NOT NULL DEFAULT 1 CHECK (quantity > 0),
  sale_minor      int  NOT NULL CHECK (sale_minor > 0),  -- each, as the customer paid

  -- Copied from the brand at the time of the order, so a change of
  -- terms later never rewrites what was owed on an old sale.
  commission_pct  numeric CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100)),
  payout_minor    int,             -- what the brand is owed for this line; NULL = terms not agreed

  customer_name   text NOT NULL,
  ship_line1      text NOT NULL,
  ship_line2      text,
  ship_town       text NOT NULL,
  ship_county     text,
  ship_postcode   text NOT NULL,
  ship_country    text NOT NULL DEFAULT 'GB',
  customer_phone  text,

  status          text NOT NULL DEFAULT 'to_ship'
                    CHECK (status IN ('to_ship','shipped','cancelled','returned')),
  carrier         text,
  tracking_number text,
  shipped_at      timestamptz,

  paid_out_at     timestamptz,
  payout_ref      text,            -- the bank reference, so a brand can match it

  is_test         boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outlet_orders_brand_idx  ON outlet_orders (brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outlet_orders_status_idx ON outlet_orders (status);

-- Fills in the copies and the payout, and keeps the stock count right.
CREATE OR REPLACE FUNCTION outlet_orders_before()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  it  outlet_items%ROWTYPE;
  pct numeric;
BEGIN
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    IF NEW.item_id IS NOT NULL THEN
      SELECT * INTO it FROM outlet_items WHERE id = NEW.item_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'That item no longer exists.'; END IF;
      NEW.brand_id       := it.brand_id;
      NEW.item_title     := COALESCE(NULLIF(NEW.item_title, ''), it.title);
      NEW.item_size      := COALESCE(NEW.item_size, it.size);
      NEW.item_colour    := COALESCE(NEW.item_colour, it.colour);
      NEW.item_condition := COALESCE(NEW.item_condition, it.condition);
      NEW.item_brand_sku := COALESCE(NEW.item_brand_sku, it.brand_sku);

      -- A real sale takes stock off the shelf. A test one does not.
      IF NOT NEW.is_test THEN
        IF it.quantity < NEW.quantity THEN
          RAISE EXCEPTION 'Only % of that item left.', it.quantity;
        END IF;
        UPDATE outlet_items SET quantity = quantity - NEW.quantity WHERE id = it.id;
      END IF;
    END IF;

    SELECT outlet_commission_pct INTO pct FROM brands WHERE id = NEW.brand_id;
    NEW.commission_pct := pct;
    NEW.payout_minor := CASE
      WHEN pct IS NULL THEN NULL
      ELSE round(NEW.sale_minor::numeric * NEW.quantity * (100 - pct) / 100)::int
    END;
  ELSE
    -- The copies and the money do not change after the sale.
    NEW.brand_id       := OLD.brand_id;
    NEW.item_id        := OLD.item_id;
    NEW.sale_minor     := OLD.sale_minor;
    NEW.quantity       := OLD.quantity;
    NEW.commission_pct := OLD.commission_pct;
    NEW.payout_minor   := OLD.payout_minor;
    NEW.is_test        := OLD.is_test;

    -- Cancelled before it went: put the stock back.
    IF NEW.status = 'cancelled' AND OLD.status = 'to_ship'
       AND NOT OLD.is_test AND OLD.item_id IS NOT NULL THEN
      UPDATE outlet_items SET quantity = quantity + OLD.quantity WHERE id = OLD.item_id;
    END IF;

    IF NEW.status = 'shipped' AND NEW.shipped_at IS NULL THEN
      NEW.shipped_at := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outlet_orders_before_trg ON outlet_orders;
CREATE TRIGGER outlet_orders_before_trg BEFORE INSERT OR UPDATE ON outlet_orders
  FOR EACH ROW EXECUTE FUNCTION outlet_orders_before();


-- ── What a brand sees of its orders ──────────────────────────
-- Brands get NO direct access to outlet_orders. They read through
-- this function instead, because of the customer's address.
--
-- A brand needs the address to post the parcel. It does not need it
-- a month later. So the address is shown while the order is waiting
-- to go and for 30 days after it has gone, and then this function
-- stops handing it over. Packet still holds it. Packet is the
-- controller of that personal data and the brand is receiving it to
-- do one job — which should be written into the brand agreement.
-- That point is input for a solicitor, not advice.
CREATE OR REPLACE FUNCTION brand_orders()
RETURNS TABLE (
  id uuid, order_ref text, created_at timestamptz,
  item_title text, item_size text, item_colour text, item_condition text, item_brand_sku text,
  quantity int, sale_minor int, commission_pct numeric, payout_minor int,
  status text, carrier text, tracking_number text, shipped_at timestamptz,
  paid_out_at timestamptz, payout_ref text, is_test boolean,
  address_shown boolean,
  customer_name text, ship_line1 text, ship_line2 text, ship_town text,
  ship_county text, ship_postcode text, ship_country text, customer_phone text
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT o.id, o.order_ref, o.created_at,
         o.item_title, o.item_size, o.item_colour, o.item_condition, o.item_brand_sku,
         o.quantity, o.sale_minor, o.commission_pct, o.payout_minor,
         o.status, o.carrier, o.tracking_number, o.shipped_at,
         o.paid_out_at, o.payout_ref, o.is_test,
         s.shown,
         CASE WHEN s.shown THEN o.customer_name  END,
         CASE WHEN s.shown THEN o.ship_line1     END,
         CASE WHEN s.shown THEN o.ship_line2     END,
         CASE WHEN s.shown THEN o.ship_town      END,
         CASE WHEN s.shown THEN o.ship_county    END,
         CASE WHEN s.shown THEN o.ship_postcode  END,
         CASE WHEN s.shown THEN o.ship_country   END,
         CASE WHEN s.shown THEN o.customer_phone END
    FROM outlet_orders o
    CROSS JOIN LATERAL (
      SELECT (o.status = 'to_ship'
              OR (o.status = 'shipped' AND o.shipped_at > now() - interval '30 days')) AS shown
    ) s
   WHERE o.brand_id = current_brand_id()
   ORDER BY o.created_at DESC;
$$;
REVOKE ALL ON FUNCTION brand_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_orders() TO authenticated;

-- The one change a brand can make to an order: it has gone, and here
-- is how to follow it. Nothing else — not the price, not the payout.
CREATE OR REPLACE FUNCTION brand_mark_shipped(p_order uuid, p_carrier text, p_tracking text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b uuid := current_brand_id();
  n int;
BEGIN
  IF b IS NULL THEN RAISE EXCEPTION 'Not a brand login.' USING ERRCODE = '42501'; END IF;
  IF COALESCE(btrim(p_carrier), '') = '' THEN
    RAISE EXCEPTION 'Say who it went with.' USING ERRCODE = '23514';
  END IF;

  UPDATE outlet_orders
     SET status = 'shipped',
         carrier = left(btrim(p_carrier), 60),
         tracking_number = NULLIF(left(btrim(COALESCE(p_tracking, '')), 80), ''),
         shipped_at = now()
   WHERE id = p_order AND brand_id = b AND status IN ('to_ship','shipped');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'That order is not one of yours, or it has been cancelled.'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION brand_mark_shipped(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_mark_shipped(uuid, text, text) TO authenticated;


-- ── Row level security ──────────────────────────────────────
ALTER TABLE outlet_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlet_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON outlet_items  FROM anon;
REVOKE ALL ON outlet_orders FROM anon;

DROP POLICY IF EXISTS "Staff manage outlet items" ON outlet_items;
CREATE POLICY "Staff manage outlet items" ON outlet_items FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

DROP POLICY IF EXISTS "Brand reads own items"    ON outlet_items;
DROP POLICY IF EXISTS "Brand adds own items"     ON outlet_items;
DROP POLICY IF EXISTS "Brand edits own items"    ON outlet_items;
DROP POLICY IF EXISTS "Brand deletes own drafts" ON outlet_items;

CREATE POLICY "Brand reads own items" ON outlet_items FOR SELECT
  USING (current_user_role() = 'brand' AND brand_id = current_brand_id());
CREATE POLICY "Brand adds own items" ON outlet_items FOR INSERT
  WITH CHECK (current_user_role() = 'brand' AND brand_id = current_brand_id());
CREATE POLICY "Brand edits own items" ON outlet_items FOR UPDATE
  USING (current_user_role() = 'brand' AND brand_id = current_brand_id())
  WITH CHECK (current_user_role() = 'brand' AND brand_id = current_brand_id());
-- Only something nobody has seen yet. Once submitted, Packet may have
-- looked at it; withdrawing keeps the record.
CREATE POLICY "Brand deletes own drafts" ON outlet_items FOR DELETE
  USING (current_user_role() = 'brand' AND brand_id = current_brand_id() AND status = 'draft');

-- Orders: staff read and update; only an owner deletes. A brand has
-- no policy here at all — it reads through brand_orders().
DROP POLICY IF EXISTS "Staff read outlet orders"   ON outlet_orders;
DROP POLICY IF EXISTS "Staff add outlet orders"    ON outlet_orders;
DROP POLICY IF EXISTS "Staff update outlet orders" ON outlet_orders;
DROP POLICY IF EXISTS "Owner delete outlet orders" ON outlet_orders;
CREATE POLICY "Staff read outlet orders" ON outlet_orders FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
CREATE POLICY "Staff add outlet orders" ON outlet_orders FOR INSERT
  WITH CHECK (current_user_role() IN ('owner','staff'));
CREATE POLICY "Staff update outlet orders" ON outlet_orders FOR UPDATE
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));
CREATE POLICY "Owner delete outlet orders" ON outlet_orders FOR DELETE
  USING (current_user_role() = 'owner');


-- ── Photos ──────────────────────────────────────────────────
-- A public bucket: these photos end up on a public shop anyway, and a
-- public link is what a Shopify listing will want. Each brand can only
-- put files in a folder named after its own brand id.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('outlet-photos', 'outlet-photos', true, 5242880,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Schema-qualified on purpose: storage requests do not run with
-- public on the search path.
DROP POLICY IF EXISTS "Outlet photos: brand uploads own"  ON storage.objects;
DROP POLICY IF EXISTS "Outlet photos: brand removes own"  ON storage.objects;
DROP POLICY IF EXISTS "Outlet photos: brand lists own"    ON storage.objects;
DROP POLICY IF EXISTS "Outlet photos: staff manage"       ON storage.objects;

CREATE POLICY "Outlet photos: brand uploads own" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'outlet-photos'
              AND public.current_user_role() = 'brand'
              AND (storage.foldername(name))[1] = public.current_brand_id()::text);
CREATE POLICY "Outlet photos: brand removes own" ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'outlet-photos'
         AND public.current_user_role() = 'brand'
         AND (storage.foldername(name))[1] = public.current_brand_id()::text);
CREATE POLICY "Outlet photos: brand lists own" ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'outlet-photos'
         AND public.current_user_role() = 'brand'
         AND (storage.foldername(name))[1] = public.current_brand_id()::text);
CREATE POLICY "Outlet photos: staff manage" ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'outlet-photos' AND public.current_user_role() IN ('owner','staff'))
  WITH CHECK (bucket_id = 'outlet-photos' AND public.current_user_role() IN ('owner','staff'));


-- ── 6. Close the view hole ───────────────────────────────────
-- See the note at the top. With security_invoker a view reads its
-- tables as the person asking, so their own row level security
-- applies. Staff see exactly what they saw before; a brand sees
-- nothing, because it has no policy on any of the tables underneath.
ALTER VIEW supplier_product_costs    SET (security_invoker = true);
ALTER VIEW product_find_counts       SET (security_invoker = true);
ALTER VIEW product_find_latest_check SET (security_invoker = true);
ALTER VIEW brand_latest_check        SET (security_invoker = true);
ALTER VIEW brand_pipeline_counts     SET (security_invoker = true);


-- ── 7. Counts for the staff Outlet page ──────────────────────
CREATE OR REPLACE VIEW outlet_brand_summary
WITH (security_invoker = true) AS
SELECT
  b.id AS brand_id,
  b.name,
  b.outlet_commission_pct,
  b.outlet_terms_agreed_at,
  count(DISTINCT i.id) FILTER (WHERE i.status = 'submitted') AS n_waiting,
  count(DISTINCT i.id) FILTER (WHERE i.status = 'live')      AS n_live,
  COALESCE(sum(i.quantity) FILTER (WHERE i.status = 'live'), 0) AS units_live
FROM brands b
LEFT JOIN outlet_items i ON i.brand_id = b.id
GROUP BY b.id, b.name, b.outlet_commission_pct, b.outlet_terms_agreed_at;


-- ============================================================
-- After running this:
--   1. Deploy as usual. brand.html arrives with the admin site.
--   2. In the admin, Brands: the brand must be on the list first.
--   3. Outlet page: "Give a brand a login". That is the only way a
--      brand login is made — never through Supabase's own screens,
--      because only manage-users.js stamps it as a brand.
-- ============================================================
