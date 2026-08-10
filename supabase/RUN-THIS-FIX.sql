-- ============================================================
-- Packet — fix for "Failed to create user: {}"
-- ============================================================
-- Run this once in the Supabase SQL editor, then try adding the
-- user again. It is safe to run more than once.
--
-- What went wrong: create_user_profile() is a SECURITY DEFINER
-- trigger on auth.users, but its search_path was never pinned. The
-- trigger fires from inside an auth insert, where the search path
-- does not include public, so user_profiles failed to resolve, the
-- trigger threw, and the entire user creation rolled back. The
-- dashboard could not read the underlying Postgres error, so it
-- showed an empty {}.
--
-- Fixed in 002_roles_and_rls.sql as well, so a fresh setup will not
-- hit this. Once this has been run you can delete this file.
-- ============================================================

-- 1. Pin the search path and stop a profile failure ever blocking a login.
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO user_profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Creating a login must never fail because a profile row could not
  -- be written. current_user_role() already falls back to least
  -- privilege when the row is missing, and step 3 below backfills it.
  RAISE WARNING 'create_user_profile failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- 2. Same fix on the role helper, for the same reason.
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT role FROM user_profiles WHERE id = auth.uid()), 'staff');
$$;

-- 3. Backfill anyone who exists in auth but has no profile row.
INSERT INTO user_profiles (id, full_name)
SELECT u.id, COALESCE(u.raw_user_meta_data->>'full_name', '')
  FROM auth.users u
  LEFT JOIN user_profiles p ON p.id = u.id
 WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- 4. Check what you have. Should list every login and its role.
SELECT u.email, p.role, p.full_name, u.created_at
  FROM auth.users u
  LEFT JOIN user_profiles p ON p.id = u.id
 ORDER BY u.created_at;

-- ============================================================
-- Now go back to Authentication -> Users -> Add user and create
-- info@packetlabel.com with auto-confirm ticked. Then promote:
--
--   UPDATE user_profiles SET role = 'owner', full_name = 'Phil Munro'
--    WHERE id = (SELECT id FROM auth.users
--                 WHERE email = 'info@packetlabel.com');
--
-- If it STILL fails, the trigger is not the cause. Run this to take
-- it out of the way, create the user, then re-run 002 to put it back:
--
--   DROP TRIGGER IF EXISTS trg_create_user_profile ON auth.users;
-- ============================================================
