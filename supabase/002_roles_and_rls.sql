-- ============================================================
-- Packet — Migration 002: Roles + Row Level Security
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- The kit's big time-saver, applied on day one rather than
-- retro-fitted. Every policy goes through current_user_role().
--
-- Packet's roles (from the project folder): owner, staff, supplier,
-- customer. Only owner and staff exist at this stage — supplier and
-- customer arrive with the Shopify build. The CHECK constraint below
-- already allows all four so adding them later is not a migration.
--
--   owner    — Phil and Scott. Everything, including deletion.
--   staff    — reads the list, can unsubscribe someone by hand,
--              cannot delete and cannot change a public promise.
--   supplier — reserved. Will see only their own rows.
--   customer — reserved. Shopify owns customer accounts.
--
-- Note the difference from the JWT approach: the role lives in a
-- table, not in the sign-in token, so changing someone's role takes
-- effect immediately instead of after they sign out and back in.
-- ============================================================

-- ── user_profiles + role plumbing ───────────────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'staff'
              CHECK (role IN ('owner','staff','supplier','customer')),
  full_name   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-create a profile for every new auth user, at least privilege.
-- The COALESCE and ON CONFLICT are the kit's fixed version — an
-- earlier build broke here when raw_user_meta_data was null.
--
-- TWO ADDITIONS, BOTH LEARNED THE HARD WAY ON THIS BUILD:
--
-- 1. SET search_path = public. This trigger fires from inside an
--    auth.users insert, where the search path does NOT include
--    public. Without this line, user_profiles fails to resolve, the
--    trigger throws, and the whole user creation rolls back — the
--    Supabase dashboard reports only "Failed to create user: {}".
--
-- 2. The exception handler. Creating a login must never fail because
--    a profile row could not be written. current_user_role() already
--    falls back to least privilege when a row is missing, so a
--    warning and carrying on is strictly safer than a hard failure.
--    Backfill any missing rows with the statement at the bottom.
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO user_profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'create_user_profile failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_user_profile ON auth.users;
CREATE TRIGGER trg_create_user_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_user_profile();

-- Role helper used throughout RLS. SECURITY DEFINER + STABLE.
-- Fail-safe: an unknown user gets least privilege, not most.
-- search_path pinned for the same reason as the trigger above.
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT role FROM user_profiles WHERE id = auth.uid()), 'staff');
$$;


-- ── Enable RLS everywhere ───────────────────────────────────
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_views    ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts  ENABLE ROW LEVEL SECURITY;

-- Belt and braces. Supabase grants anon table privileges in the
-- public schema by default. RLS already blocks them, but revoking
-- makes the intent explicit and survives someone adding a
-- permissive policy later.
REVOKE ALL ON user_profiles FROM anon;
REVOKE ALL ON app_settings  FROM anon;
REVOKE ALL ON subscribers   FROM anon;
REVOKE ALL ON assessments   FROM anon;
REVOKE ALL ON page_views    FROM anon;
REVOKE ALL ON social_posts  FROM anon;

-- There is deliberately NO anon policy on any table. Everything the
-- public site can do goes through the functions in 003.


-- ── user_profiles ───────────────────────────────────────────
DROP POLICY IF EXISTS "Users read own profile" ON user_profiles;
DROP POLICY IF EXISTS "Owner manages profiles" ON user_profiles;

CREATE POLICY "Users read own profile" ON user_profiles FOR SELECT
  USING (id = auth.uid());
CREATE POLICY "Owner manages profiles" ON user_profiles FOR ALL
  USING (current_user_role() = 'owner') WITH CHECK (current_user_role() = 'owner');


-- ── app_settings ────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff read settings"  ON app_settings;
DROP POLICY IF EXISTS "Owner write settings" ON app_settings;

CREATE POLICY "Staff read settings" ON app_settings FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
-- Owner only. Changing discount_terms changes what Packet has
-- publicly promised, so it is not a staff-level action.
CREATE POLICY "Owner write settings" ON app_settings FOR ALL
  USING (current_user_role() = 'owner') WITH CHECK (current_user_role() = 'owner');


-- ── subscribers ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff read subscribers"   ON subscribers;
DROP POLICY IF EXISTS "Staff update subscribers" ON subscribers;
DROP POLICY IF EXISTS "Owner delete subscribers" ON subscribers;

CREATE POLICY "Staff read subscribers" ON subscribers FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
-- Staff can mark someone unsubscribed by hand — they replied asking
-- to come off rather than clicking the link, and that must be honoured.
CREATE POLICY "Staff update subscribers" ON subscribers FOR UPDATE
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));
-- Deletion is the UK GDPR right to erasure. Owner only.
CREATE POLICY "Owner delete subscribers" ON subscribers FOR DELETE
  USING (current_user_role() = 'owner');


-- ── assessments ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff read assessments"   ON assessments;
DROP POLICY IF EXISTS "Staff update assessments" ON assessments;
DROP POLICY IF EXISTS "Owner delete assessments" ON assessments;

CREATE POLICY "Staff read assessments" ON assessments FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
-- Marking a code redeemed once there is a shop.
CREATE POLICY "Staff update assessments" ON assessments FOR UPDATE
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));
-- An assessment row is personal data like any other.
CREATE POLICY "Owner delete assessments" ON assessments FOR DELETE
  USING (current_user_role() = 'owner');


-- ── page_views ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff read page views" ON page_views;

CREATE POLICY "Staff read page views" ON page_views FOR SELECT
  USING (current_user_role() IN ('owner','staff'));


-- ── social_posts ────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff manage social posts" ON social_posts;

-- Drafting and scheduling is day-to-day work, so staff can do it all.
CREATE POLICY "Staff manage social posts" ON social_posts FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));


-- ── backfill ────────────────────────────────────────────────
-- Safe to run any time. Gives a profile to any auth user who does
-- not have one — for instance anyone created while the trigger was
-- broken, or created by a route that bypassed it.
INSERT INTO user_profiles (id, full_name)
SELECT u.id, COALESCE(u.raw_user_meta_data->>'full_name', '')
  FROM auth.users u
  LEFT JOIN user_profiles p ON p.id = u.id
 WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- After running this, create the admin users in the Supabase
-- dashboard (Authentication -> Users -> Add user, auto-confirm),
-- then promote the owner. The profile row already exists — the
-- trigger above created it at 'staff'.
--
--   UPDATE user_profiles SET role = 'owner', full_name = 'Phil Munro'
--    WHERE id = (SELECT id FROM auth.users WHERE email = 'info@packetlabel.com');
--
-- Use 'staff' for any account that should not be able to delete a
-- subscriber or change a public promise. Unlike the JWT approach, a
-- role change here takes effect immediately — no sign-out needed.
--
-- Next: 003_public_functions.sql.
-- ============================================================
