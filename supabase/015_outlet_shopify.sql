-- ============================================================
-- Packet — Migration 015: Outlet stock in the Shopify shop
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 2 November 2026.
--
-- 014 gave brands a login and a stock list. Until now nothing a
-- customer could see came from it: orders were typed in by hand.
-- This migration holds the bookkeeping for the link that makes the
-- Outlet a real shop:
--
--   When Packet puts an item on sale, netlify-functions/outlet-shopify
--   creates it as a product in the Shopify shop (tagged "outlet", in
--   the Outlet collection). Price, stock count and on/off follow this
--   table from then on, every ten minutes and straight away when
--   Packet presses a button.
--
--   When a customer pays, Shopify tells netlify-functions/shopify-webhook,
--   which writes the order here. The brand sees it on their Orders page
--   exactly as a hand-entered order appeared before.
--
--   When the brand marks it posted, the next run tells Shopify, which
--   emails the customer the tracking number.
--
-- ── Decision 3 ──────────────────────────────────────────────
-- Shopify owns what the customer sees. The link writes the title,
-- description and photos ONCE, when the item first goes on sale.
-- After that it only ever changes price, stock count and whether the
-- item is showing. Edit the wording in Shopify, not here.
--
-- Safe to run twice. Run order: ... -> 013 -> 014 -> 015.
-- ============================================================


-- ── 1. Where each item lives in Shopify ─────────────────────
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS shopify_variant_id        text;
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS shopify_inventory_item_id text;
-- The updated_at value the shop was last brought into line with.
-- An item needs sending to Shopify whenever updated_at is later.
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS shopify_synced_at         timestamptz;
ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS shopify_sync_error        text;

CREATE INDEX IF NOT EXISTS outlet_items_shopify_product_idx ON outlet_items (shopify_product_id);

-- Writing the link's own bookkeeping must not count as a change to the
-- item, or every sync would make the item look out of date again.
-- Trigger names fire in alphabetical order, so this runs after the
-- guard from 014 has stamped updated_at, and puts it back.
CREATE OR REPLACE FUNCTION outlet_items_sync_bookkeeping()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.shopify_synced_at         IS DISTINCT FROM OLD.shopify_synced_at
   OR NEW.shopify_sync_error        IS DISTINCT FROM OLD.shopify_sync_error
   OR NEW.shopify_product_id        IS DISTINCT FROM OLD.shopify_product_id
   OR NEW.shopify_variant_id        IS DISTINCT FROM OLD.shopify_variant_id
   OR NEW.shopify_inventory_item_id IS DISTINCT FROM OLD.shopify_inventory_item_id)
  AND NEW.title          IS NOT DISTINCT FROM OLD.title
  AND NEW.quantity       IS NOT DISTINCT FROM OLD.quantity
  AND NEW.sale_minor     IS NOT DISTINCT FROM OLD.sale_minor
  AND NEW.status         IS NOT DISTINCT FROM OLD.status
  AND NEW.floor_minor    IS NOT DISTINCT FROM OLD.floor_minor
  THEN
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outlet_items_zz_sync_trg ON outlet_items;
CREATE TRIGGER outlet_items_zz_sync_trg BEFORE UPDATE ON outlet_items
  FOR EACH ROW EXECUTE FUNCTION outlet_items_sync_bookkeeping();

-- A brand must not be able to write the link's columns either.
-- 014's guard already protects shopify_product_id; this covers the rest.
CREATE OR REPLACE FUNCTION outlet_items_sync_brand_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user_role() = 'brand' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.shopify_variant_id := NULL; NEW.shopify_inventory_item_id := NULL;
      NEW.shopify_synced_at := NULL;  NEW.shopify_sync_error := NULL;
    ELSE
      NEW.shopify_variant_id        := OLD.shopify_variant_id;
      NEW.shopify_inventory_item_id := OLD.shopify_inventory_item_id;
      NEW.shopify_synced_at         := OLD.shopify_synced_at;
      NEW.shopify_sync_error        := OLD.shopify_sync_error;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outlet_items_zy_brand_sync_guard_trg ON outlet_items;
CREATE TRIGGER outlet_items_zy_brand_sync_guard_trg BEFORE INSERT OR UPDATE ON outlet_items
  FOR EACH ROW EXECUTE FUNCTION outlet_items_sync_brand_guard();


-- ── 2. Orders that came from Shopify ────────────────────────
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS shopify_order_id      text;
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS shopify_line_item_id  text;
-- Set when Shopify has been told the parcel has gone.
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS shopify_fulfilled_at  timestamptz;
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS shopify_fulfil_error  text;
-- The customer paid for more than the brand had left. Shopify's own
-- stock count normally stops this; it can still happen if a brand
-- lowers their number in the minutes before the shop catches up.
-- The order is recorded anyway, flagged, so nobody's money goes missing.
ALTER TABLE outlet_orders ADD COLUMN IF NOT EXISTS oversold boolean NOT NULL DEFAULT false;

-- Shopify sends the same notification more than once if it does not
-- hear back quickly. One row per Shopify line, however many times.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outlet_orders_shopify_line_uniq') THEN
    ALTER TABLE outlet_orders ADD CONSTRAINT outlet_orders_shopify_line_uniq UNIQUE (shopify_line_item_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS outlet_orders_shopify_order_idx ON outlet_orders (shopify_order_id);

-- 014's order trigger, with one change: a Shopify order is never
-- refused for want of stock. The customer has already paid.
CREATE OR REPLACE FUNCTION outlet_orders_before()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  it  outlet_items%ROWTYPE;
  pct numeric;
BEGIN
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    IF NEW.item_id IS NOT NULL THEN
      SELECT * INTO it FROM outlet_items WHERE id = NEW.item_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'That item no longer exists.'; END IF;
      NEW.brand_id       := it.brand_id;
      NEW.item_title     := COALESCE(NULLIF(NEW.item_title, ''), it.title);
      NEW.item_size      := COALESCE(NEW.item_size, it.size);
      NEW.item_colour    := COALESCE(NEW.item_colour, it.colour);
      NEW.item_condition := COALESCE(NEW.item_condition, it.condition);
      NEW.item_brand_sku := COALESCE(NEW.item_brand_sku, it.brand_sku);

      IF NOT NEW.is_test THEN
        IF it.quantity < NEW.quantity THEN
          IF NEW.shopify_line_item_id IS NULL THEN
            RAISE EXCEPTION 'Only % of that item left.', it.quantity;
          END IF;
          NEW.oversold := true;
          UPDATE outlet_items SET quantity = 0 WHERE id = it.id;
        ELSE
          UPDATE outlet_items SET quantity = quantity - NEW.quantity WHERE id = it.id;
        END IF;
      END IF;
    END IF;

    SELECT outlet_commission_pct INTO pct FROM brands WHERE id = NEW.brand_id;
    NEW.commission_pct := pct;
    NEW.payout_minor := CASE
      WHEN pct IS NULL THEN NULL
      ELSE round(NEW.sale_minor::numeric * NEW.quantity * (100 - pct) / 100)::int
    END;
  ELSE
    NEW.brand_id       := OLD.brand_id;
    NEW.item_id        := OLD.item_id;
    NEW.sale_minor     := OLD.sale_minor;
    NEW.quantity       := OLD.quantity;
    NEW.commission_pct := OLD.commission_pct;
    NEW.payout_minor   := OLD.payout_minor;
    NEW.is_test        := OLD.is_test;
    NEW.shopify_order_id     := OLD.shopify_order_id;
    NEW.shopify_line_item_id := OLD.shopify_line_item_id;
    NEW.oversold             := OLD.oversold;

    IF NEW.status = 'cancelled' AND OLD.status = 'to_ship'
       AND NOT OLD.is_test AND OLD.item_id IS NOT NULL AND NOT OLD.oversold THEN
      UPDATE outlet_items SET quantity = quantity + OLD.quantity WHERE id = OLD.item_id;
    END IF;

    IF NEW.status = 'shipped' AND NEW.shipped_at IS NULL THEN
      NEW.shipped_at := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ── 3. Settings the link finds for itself ───────────────────
-- Filled in by the "Connect Shopify" button on the Outlet page. Not
-- secrets: the Shopify keys live in Netlify, never in the database.
INSERT INTO app_settings (key, value, note, is_public) VALUES
  ('shopify_location_id',    '', 'Shopify location Outlet stock is counted at. Found by Connect Shopify.', false),
  ('shopify_publication_id', '', 'Shopify Online Store sales channel. Found by Connect Shopify.', false),
  ('shopify_outlet_collection_id', '', 'The Outlet collection in Shopify. Made by Connect Shopify.', false),
  ('shopify_connected_at',   '', 'When Connect Shopify last succeeded.', false)
ON CONFLICT (key) DO NOTHING;
