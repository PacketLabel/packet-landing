-- ============================================================
-- Packet — Migration 003: Public functions
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- The kit's 003 is place_order — the one RPC the public site is
-- allowed to call. Packet has no checkout (Shopify owns that), so
-- this is the equivalent for a pre-launch shop: the five narrow
-- functions the anon key may execute, and nothing else.
--
-- With the anon key alone you can sign someone up, unsubscribe
-- someone, count a page view, read the public settings, and submit
-- one assessment. You cannot read the subscriber list, enumerate
-- discount codes, or read anyone's answers.
--
-- ONE THING TO UNDERSTAND BEFORE CHANGING ANY OF THIS
-- ---------------------------------------------------
-- The discount code and the marketing consent are deliberately
-- separate. Someone gives an email address so the code can be sent
-- to them; that is a different thing from agreeing to receive
-- marketing, and the tick box is optional. complete_assessment()
-- issues the code either way. Do not "simplify" this by making the
-- tick box compulsory — bundling consent with access to something is
-- the specific arrangement that causes trouble, and the whole list is
-- prospective customers, so the soft opt-in does not apply.
-- A design decision, not a compliance sign-off. Put it to the solicitor.
-- ============================================================


-- ── subscribe() ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION subscribe(
  p_email        text,
  p_consent      boolean,
  p_consent_text text,
  p_source       text DEFAULT 'landing',
  p_utm_source   text DEFAULT NULL,
  p_utm_medium   text DEFAULT NULL,
  p_utm_campaign text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email text;
BEGIN
  v_email := lower(btrim(coalesce(p_email, '')));

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid_email' USING errcode = '22023';
  END IF;

  -- Consent must be affirmative. A pre-ticked or absent box is not consent.
  IF p_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'consent_required' USING errcode = '22023';
  END IF;

  IF length(coalesce(p_consent_text, '')) < 10 THEN
    RAISE EXCEPTION 'consent_text_required' USING errcode = '22023';
  END IF;

  INSERT INTO subscribers
    (email, consent_marketing, consent_text, consent_at,
     source, utm_source, utm_medium, utm_campaign)
  VALUES
    (v_email, true, p_consent_text, now(),
     coalesce(p_source, 'landing'), p_utm_source, p_utm_medium, p_utm_campaign)
  ON CONFLICT (lower(email)) DO UPDATE
    SET consent_marketing = true,
        consent_text      = excluded.consent_text,
        consent_at        = now(),
        -- Signing up again after unsubscribing is fresh consent, so
        -- this correctly brings them back on.
        unsubscribed_at   = NULL,
        source            = excluded.source;
END;
$$;


-- ── unsubscribe() ───────────────────────────────────────────
-- Called by the link in every email. No login, no form, no "are you sure".
CREATE OR REPLACE FUNCTION unsubscribe(p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows int; v_exists boolean;
BEGIN
  UPDATE subscribers
     SET unsubscribed_at   = now(),
         consent_marketing = false
   WHERE unsubscribe_token = p_token
     AND unsubscribed_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN RETURN true; END IF;

  -- Already unsubscribed: still report success. Clicking twice should
  -- not produce an error that makes someone think it failed.
  SELECT true INTO v_exists FROM subscribers WHERE unsubscribe_token = p_token;
  RETURN coalesce(v_exists, false);
END;
$$;


-- ── log_view() ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION log_view(
  p_path         text,
  p_referrer     text DEFAULT NULL,
  p_utm_source   text DEFAULT NULL,
  p_utm_medium   text DEFAULT NULL,
  p_utm_campaign text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO page_views (path, referrer, utm_source, utm_medium, utm_campaign)
  VALUES (
    left(coalesce(p_path, '/'), 200),
    left(p_referrer, 300),
    left(p_utm_source, 100),
    left(p_utm_medium, 100),
    left(p_utm_campaign, 100)
  );
END;
$$;


-- ── public_settings() ───────────────────────────────────────
-- The handful of values the public pages are allowed to read.
CREATE OR REPLACE FUNCTION public_settings()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM app_settings WHERE is_public;
$$;


-- ── complete_assessment() ───────────────────────────────────
-- Returns the discount code. Issues it whether or not marketing was
-- consented to; see the note at the top of this file.
CREATE OR REPLACE FUNCTION complete_assessment(
  p_email        text,
  p_answers      jsonb,
  p_consent      boolean DEFAULT false,
  p_consent_text text    DEFAULT NULL,
  p_utm_source   text    DEFAULT NULL,
  p_utm_medium   text    DEFAULT NULL,
  p_utm_campaign text    DEFAULT NULL
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email    text;
  v_live     text;
  v_prefix   text;
  v_code     text;
  v_existing text;
  v_try      int := 0;
BEGIN
  v_email := lower(btrim(coalesce(p_email, '')));

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid_email' USING errcode = '22023';
  END IF;

  SELECT value INTO v_live FROM app_settings WHERE key = 'assessment_live';
  IF coalesce(v_live, 'false') <> 'true' THEN
    RAISE EXCEPTION 'assessment_closed' USING errcode = '22023';
  END IF;

  -- Belt and braces. A code is a promise, and the promise has to have
  -- been written down and agreed before anyone can be issued one.
  IF (SELECT value FROM app_settings WHERE key = 'discount_terms')
     IN ('', 'TERMS NOT SET') THEN
    RAISE EXCEPTION 'discount_terms_not_set' USING errcode = '22023';
  END IF;

  -- Cap the payload. Nothing legitimate comes near this, and it stops
  -- the anon key being used to write arbitrary volumes into the table.
  IF length(p_answers::text) > 8000 THEN
    RAISE EXCEPTION 'answers_too_large' USING errcode = '22023';
  END IF;

  -- One code per address. Doing it again returns the same code rather
  -- than minting a second, so the page is safe to refresh or resubmit.
  SELECT discount_code INTO v_existing
    FROM assessments WHERE lower(email) = v_email LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Still honour a consent tick given on a later attempt, and never
    -- silently withdraw consent that was already given.
    IF p_consent IS TRUE THEN
      UPDATE assessments SET consent_marketing = true WHERE lower(email) = v_email;

      INSERT INTO subscribers
        (email, consent_marketing, consent_text, consent_at, source,
         utm_source, utm_medium, utm_campaign)
      VALUES
        (v_email, true, coalesce(p_consent_text, 'assessment'), now(), 'assessment',
         p_utm_source, p_utm_medium, p_utm_campaign)
      ON CONFLICT (lower(email)) DO UPDATE
        SET consent_marketing = true,
            consent_text      = excluded.consent_text,
            consent_at        = now(),
            unsubscribed_at   = NULL;
    END IF;
    RETURN v_existing;
  END IF;

  SELECT coalesce(value, 'PKT') INTO v_prefix FROM app_settings WHERE key = 'code_prefix';

  -- Readable code, no ambiguous characters (no O/0, I/1).
  LOOP
    v_try := v_try + 1;
    SELECT coalesce(v_prefix, 'PKT') || '-' ||
           string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                             1 + floor(random() * 32)::int, 1), '')
      INTO v_code
      FROM generate_series(1, 6);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM assessments WHERE discount_code = v_code);
    IF v_try > 20 THEN
      RAISE EXCEPTION 'code_generation_failed' USING errcode = '22023';
    END IF;
  END LOOP;

  INSERT INTO assessments
    (email, answers, discount_code, consent_marketing,
     utm_source, utm_medium, utm_campaign)
  VALUES
    (v_email, coalesce(p_answers, '{}'::jsonb), v_code, coalesce(p_consent, false),
     p_utm_source, p_utm_medium, p_utm_campaign);

  -- Only join the mailing list if they actually asked to. An
  -- assessment on its own is not consent to be marketed at.
  IF p_consent IS TRUE THEN
    INSERT INTO subscribers
      (email, consent_marketing, consent_text, consent_at, source,
       utm_source, utm_medium, utm_campaign)
    VALUES
      (v_email, true, coalesce(p_consent_text, 'assessment'), now(), 'assessment',
       p_utm_source, p_utm_medium, p_utm_campaign)
    ON CONFLICT (lower(email)) DO UPDATE
      SET consent_marketing = true,
          consent_text      = excluded.consent_text,
          consent_at        = now(),
          unsubscribed_at   = NULL;
  END IF;

  RETURN v_code;
END;
$$;


-- ── Function privileges — anon may execute these five, and nothing else
REVOKE ALL ON FUNCTION subscribe(text, boolean, text, text, text, text, text) FROM public;
REVOKE ALL ON FUNCTION unsubscribe(uuid) FROM public;
REVOKE ALL ON FUNCTION log_view(text, text, text, text, text) FROM public;
REVOKE ALL ON FUNCTION public_settings() FROM public;
REVOKE ALL ON FUNCTION complete_assessment(text, jsonb, boolean, text, text, text, text) FROM public;

GRANT EXECUTE ON FUNCTION subscribe(text, boolean, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION unsubscribe(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION log_view(text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_settings() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_assessment(text, jsonb, boolean, text, text, text, text) TO anon, authenticated;

-- current_user_role() is for signed-in users only. anon must not have it.
REVOKE ALL ON FUNCTION current_user_role() FROM public, anon;
GRANT EXECUTE ON FUNCTION current_user_role() TO authenticated;

-- ============================================================
-- Migrations complete. Before going live, set the assessment switch:
--   UPDATE app_settings SET value = 'true' WHERE key = 'assessment_live';
-- Leaving it false is safe — the page says it is not running and no
-- code can be issued.
-- ============================================================
