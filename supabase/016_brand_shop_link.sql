-- ============================================================
-- Packet — Migration 016: the shop link (a brand's own Shopify → Outlet)
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 2 November 2026.
--
-- Until now a brand's stock reached Packet by hand or by spreadsheet.
-- This lets a brand on Shopify plug their shop in once:
--
--   They tag products "packet-outlet" in their own Shopify. Every ten
--   minutes netlify-functions/brand-shop.js reads those products and
--   keeps outlet_items in step: new sizes arrive for Packet to price,
--   and the number left follows their shop.
--
--   When something sells on Packet, the same run takes it off their
--   Shopify stock, so they cannot sell the last one twice. If the
--   order is cancelled, it is put back.
--
-- The keys to a brand's shop are kept in brand_shops, which no login
-- can read — not a brand, not Packet staff. Only the server function
-- (service key) touches it. Screens see brand_shop_status() instead.
--
-- Safe to run twice. Run order: ... -> 014 -> 015 -> 016.
-- ============================================================


-- ── 1. One row per connected shop ───────────────────────────
CREATE TABLE IF NOT EXISTS brand_shops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
  platform         text NOT NULL DEFAULT 'shopify' CHECK (platform IN ('shopify')),
  shop_domain      text NOT NULL UNIQUE CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),

  -- The app this brand installs. While Packet has no app approved by
  -- Shopify for general use, each brand gets its own app made in the
  -- Dev Dashboard, so the keys live here. Blank = use the shared app
  -- in Netlify (SHOPIFY_LINK_CLIENT_ID / _SECRET) once there is one.
  client_id        text,
  client_secret    text,

  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  scopes           text,
  oauth_state      text,

  --   waiting       set up by Packet, the brand has not installed it yet
  --   connected     working
  --   error         the last run failed; last_error says why
  --   disconnected  the brand removed the app, or Packet switched it off
  status           text NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting','connected','error','disconnected')),

  -- How their products come across when the tags do not say.
  outlet_tag        text NOT NULL DEFAULT 'packet-outlet',
  default_condition text NOT NULL DEFAULT 'new_with_tags'
                      CHECK (default_condition IN ('new_with_tags','new_no_tags','returned_as_new',
                                                   'returned_worn','box_damaged','minor_fault')),
  default_category  text NOT NULL DEFAULT 'clothing'
                      CHECK (default_category IN ('clothing','footwear','accessories','jewellery',
                                                  'beauty','home','kids','pets','other')),
  lowest_pct        int  NOT NULL DEFAULT 50 CHECK (lowest_pct BETWEEN 1 AND 100),

  connected_at     timestamptz,
  last_sync_at     timestamptz,
  last_error       text,
  last_warnings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  items_linked     int NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE brand_shops ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: with RLS on and none written, no login can
-- read or change a row. The service key is not bound by RLS.
REVOKE ALL ON brand_shops FROM anon, authenticated;


-- ── 2. Where an Outlet item came from ───────────────────────
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'packet';
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS source_ref           text;   -- their Shopify variant
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS source_inventory_ref text;   -- their Shopify stock record
DO $$ BEGIN
  ALTER TABLE outlet_items ADD CONSTRAINT outlet_items_source_ok CHECK (source IN ('packet','shopify'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS outlet_items_source_ref_uq
  ON outlet_items (brand_id, source_ref) WHERE source_ref IS NOT NULL;

-- A brand must not be able to point an item at someone else's stock,
-- or unhook it from their shop so it stops following. Those three
-- columns are the link's alone.
CREATE OR REPLACE FUNCTION outlet_items_source_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user_role() = 'brand' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.source := 'packet'; NEW.source_ref := NULL; NEW.source_inventory_ref := NULL;
    ELSE
      NEW.source := OLD.source; NEW.source_ref := OLD.source_ref; NEW.source_inventory_ref := OLD.source_inventory_ref;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS outlet_items_source_guard_trg ON outlet_items;
CREATE TRIGGER outlet_items_source_guard_trg BEFORE INSERT OR UPDATE ON outlet_items
  FOR EACH ROW EXECUTE FUNCTION outlet_items_source_guard();


-- ── 3. Taking Packet sales off the brand's Shopify stock ─────
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS brand_stock_taken_at    timestamptz;
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS brand_stock_returned_at timestamptz;
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS brand_stock_error       text;


-- ── 4. What the screens may see ─────────────────────────────
-- A brand sees its own link; Packet staff see every link. Never a key.
CREATE OR REPLACE FUNCTION brand_shop_status()
RETURNS TABLE (
  brand_id uuid, shop_domain text, status text, outlet_tag text,
  default_condition text, default_category text, lowest_pct int,
  connected_at timestamptz, last_sync_at timestamptz, last_error text,
  last_warnings jsonb, items_linked int, own_app boolean
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT s.brand_id, s.shop_domain, s.status, s.outlet_tag,
         s.default_condition, s.default_category, s.lowest_pct,
         s.connected_at, s.last_sync_at, s.last_error,
         s.last_warnings, s.items_linked, (s.client_id IS NOT NULL)
    FROM brand_shops s
   WHERE (current_user_role() = 'brand' AND s.brand_id = current_brand_id())
      OR current_user_role() IN ('owner','staff') AND auth.uid() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION brand_shop_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_shop_status() TO authenticated;
