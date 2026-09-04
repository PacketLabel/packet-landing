-- ============================================================
-- Packet — Migration 011: Social studio, all platforms
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 4 September 2026. The social studio drafted Instagram
-- captions and nothing else. Packet needs Instagram, Facebook,
-- TikTok and Pinterest, and the useful version of that is one
-- brief producing a genuinely different post for each — not the
-- same words pasted four times, which is what a shop looks like
-- when nobody is paying attention.
--
-- NO NEW TABLE. 001_base_schema.sql already built social_posts
-- and it was close: it has channel, brief, body, hashtags, status
-- and ai_used. Four things it could not hold:
--
--   1. A TITLE. Pinterest has a pin title of its own, separate
--      from the description and capped at 100 characters, and it
--      is the field that decides whether the pin is ever found.
--      TikTok has the same shape for a different reason — the
--      spoken hook in the first three seconds is not the caption.
--      Both were being crammed into body or lost.
--
--   2. A PLATFORM-SPECIFIC EXTRA. TikTok needs on-screen text.
--      Pinterest needs search keywords, which are not hashtags
--      and behave nothing like them. One honest free-text column
--      beats two columns that are each empty three quarters of
--      the time.
--
--   3. WHICH BRIEF A POST CAME FROM. Four posts written from one
--      idea are a set. Without a batch id they are four unrelated
--      rows and there is no way to ask "what did we put out about
--      that", which is the only interesting question later.
--
--   4. PINTEREST ITSELF. The channel CHECK allowed instagram,
--      facebook, tiktok, email and other. A pin saved as 'other'
--      is a pin nobody can find again.
--
--   5. WHICH GRAPHIC LAYOUT WAS USED. The image maker rotates
--      through seven layouts so a month of posts does not all
--      look like one template. It can only avoid repeating
--      itself if it can see what it did last time, and the
--      browser's own memory does not travel between Phil's
--      machine and Scott's. Two text columns, no constraint.
--
-- Run order: ... -> 009 -> 010 -> 011.
-- ============================================================


-- ── social_posts: the four missing columns ──────────────────
ALTER TABLE social_posts
  -- Pinterest pin title, or the TikTok spoken hook. NULL on
  -- Instagram and Facebook, which genuinely have no such field —
  -- an empty string would pretend otherwise.
  ADD COLUMN IF NOT EXISTS title     text,

  -- On-screen text for TikTok; search keywords for Pinterest.
  ADD COLUMN IF NOT EXISTS extra     text,

  -- The set a post belongs to. Nullable: a draft written on its
  -- own is not part of a batch and should not be given a fake one.
  ADD COLUMN IF NOT EXISTS batch_id  uuid,

  -- question / useful / light. Recorded so the mix can be looked
  -- at later — a feed that is all questions gets tiring.
  ADD COLUMN IF NOT EXISTS post_kind text
      CHECK (post_kind IN ('question','useful','light')),

  -- Which graphic layout and ground colour the image used. This is the
  -- studio's memory: the generator reads the last few of these back and
  -- deliberately picks something else, so a run of posts varies without
  -- anybody choosing. Deliberately NOT constrained to a list of layout
  -- names — a CHECK here would mean a database migration every time a
  -- layout is added or renamed, and the cost of a stale value is that one
  -- image repeats a look.
  ADD COLUMN IF NOT EXISTS image_layout text,
  ADD COLUMN IF NOT EXISTS image_bg     text,

  -- The words that were on the graphic. The PNG itself is deliberately NOT
  -- stored: four short strings plus a layout name regenerate it exactly,
  -- take a few hundred bytes instead of a megabyte, and can still be edited
  -- afterwards. Without these, reopening a saved post gave you the caption
  -- back and a blank canvas.
  ADD COLUMN IF NOT EXISTS image_head    text,
  ADD COLUMN IF NOT EXISTS image_sub     text,
  ADD COLUMN IF NOT EXISTS image_eyebrow text,
  ADD COLUMN IF NOT EXISTS image_list    text;


-- ── channel: let Pinterest in ───────────────────────────────
-- Named explicitly rather than left to the default constraint
-- name, because a CHECK added inline in 001 may be named either
-- way depending on how it was created.
ALTER TABLE social_posts DROP CONSTRAINT IF EXISTS social_posts_channel_check;
ALTER TABLE social_posts
  ADD CONSTRAINT social_posts_channel_check
  CHECK (channel IN ('instagram','facebook','tiktok','pinterest','email','other'));


CREATE INDEX IF NOT EXISTS social_posts_batch_idx
  ON social_posts (batch_id) WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS social_posts_channel_idx
  ON social_posts (channel, created_at DESC);


-- ── RLS is unchanged ────────────────────────────────────────
-- social_posts already has its policies from 002. Adding columns
-- does not change who can read or write the table, and this
-- migration deliberately does not touch them.
