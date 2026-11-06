-- ============================================================
-- Packet — Migration 018: the brand's own Outlet price
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 6 November 2026, from the first run-through as a brand.
--
-- A brand uploading stock gives us their NORMAL price. Until now only
-- Packet could say what it sells for on the Outlet, so every item was
-- priced by hand. Phil's call (6 Nov): let the brand say it, either
--   * as a % off for the whole upload ("take 20% off everything"),
--   * as their usual Outlet discount, remembered on their account, or
--   * as a price on any one item.
--
-- What the brand sets is their ASKING price (brand_price_minor). It is
-- not the sale price. Packet still checks every item and puts it on
-- sale — the price box is simply filled in with the brand's price, and
-- the "put everything on sale" button uses it. Packet can still change
-- it. sale_minor stays Packet's alone (014's guard is untouched).
--
-- Order the suggested price is worked out in:
--   1. the brand's price on that item
--   2. the brand's usual Outlet discount, off their normal price
--   3. Packet's normal discount for that brand (017)
--   4. Packet's shop-wide default (017)
-- Never below the brand's lowest price.
--
-- Safe to run twice. Run order: ... -> 016 -> 017 -> 018.
-- ============================================================

ALTER TABLE outlet_items ADD COLUMN IF NOT EXISTS brand_price_minor int
  CHECK (brand_price_minor IS NULL OR brand_price_minor > 0);

-- The brand's usual Outlet discount: % off their normal price.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS brand_discount_pct numeric
  CHECK (brand_discount_pct IS NULL OR (brand_discount_pct >= 0 AND brand_discount_pct < 100));

-- The brand sets its own usual discount. Blank clears it.
CREATE OR REPLACE FUNCTION brand_set_discount(p_pct numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_brand_id() IS NULL THEN RAISE EXCEPTION 'Not a brand login.' USING ERRCODE = '42501'; END IF;
  IF p_pct IS NOT NULL AND (p_pct < 0 OR p_pct >= 100) THEN
    RAISE EXCEPTION 'The discount should be between 0 and 99%%.' USING ERRCODE = '23514';
  END IF;
  UPDATE brands SET brand_discount_pct = p_pct, updated_at = now() WHERE id = current_brand_id();
END;
$$;
REVOKE ALL ON FUNCTION brand_set_discount(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brand_set_discount(numeric) TO authenticated;

-- The suggested price for one item, in the order above.
CREATE OR REPLACE FUNCTION outlet_item_suggest(p_brand uuid, p_rrp int, p_floor int, p_brand_price int)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE bd numeric;
BEGIN
  IF p_brand_price IS NOT NULL THEN RETURN GREATEST(p_floor, p_brand_price); END IF;
  SELECT brand_discount_pct INTO bd FROM brands WHERE id = p_brand;
  IF bd IS NOT NULL THEN RETURN outlet_suggest_minor(p_rrp, p_floor, bd); END IF;
  RETURN outlet_suggest_minor(p_rrp, p_floor, outlet_discount_for(p_brand));
END;
$$;
REVOKE ALL ON FUNCTION outlet_item_suggest(uuid, int, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION outlet_item_suggest(uuid, int, int, int) TO authenticated;

-- my_brand() from 017, with the usual discount added.
CREATE OR REPLACE FUNCTION my_brand()
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
    'brand_discount_pct', b.brand_discount_pct,
    'terms', CASE WHEN t.version IS NULL THEN NULL ELSE
             jsonb_build_object('version', t.version, 'title', t.title, 'body', t.body) END,
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

-- 017's trigger, now using the brand's price first. Also keeps the
-- brand's price at or above their lowest, so raising the lowest price
-- later never leaves an asking price below it.
CREATE OR REPLACE FUNCTION outlet_items_ready()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b brands%ROWTYPE;
  sug int;
  becoming_live boolean;
BEGIN
  SELECT * INTO b FROM brands WHERE id = NEW.brand_id;

  IF NEW.brand_price_minor IS NOT NULL AND NEW.brand_price_minor < NEW.floor_minor THEN
    NEW.brand_price_minor := NEW.floor_minor;
  END IF;

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
    sug := outlet_item_suggest(NEW.brand_id, NEW.rrp_minor, NEW.floor_minor, NEW.brand_price_minor);
    IF sug IS NOT NULL THEN
      NEW.sale_minor  := COALESCE(NEW.sale_minor, sug);
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

-- 017's "put everything on sale", using the same order.
CREATE OR REPLACE FUNCTION outlet_list_at_suggested(p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  it outlet_items%ROWTYPE;
  sug int;
  done int := 0;
  skipped jsonb := '[]'::jsonb;
BEGIN
  IF current_user_role() NOT IN ('owner','staff') THEN RAISE EXCEPTION 'Packet staff only.' USING ERRCODE = '42501'; END IF;
  FOR it IN SELECT * FROM outlet_items WHERE id = ANY(p_ids) AND status IN ('submitted','paused') LOOP
    sug := outlet_item_suggest(it.brand_id, it.rrp_minor, it.floor_minor, it.brand_price_minor);
    IF sug IS NULL THEN
      skipped := skipped || jsonb_build_object('id', it.id, 'title', it.title, 'why', 'no price from the brand and no normal Outlet discount');
      CONTINUE;
    END IF;
    BEGIN
      UPDATE outlet_items SET sale_minor = sug, status = 'live', packet_note = NULL WHERE id = it.id;
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
