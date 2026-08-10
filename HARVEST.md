# Packet — go-live harvest

Run this retro at go-live, and again when the Shopify build starts. It is how
the AXRIK kit gets better every project: reusable wins go back to the kit,
Packet-specific code stays here.

Kit version this build started from: **1.1.0**

## What was newly reusable

Candidates spotted while building. Anything ticked should be promoted into the
kit with a `KIT-CHANGELOG.md` entry and a version bump.

- [ ] **Consent-separated lead capture.** A discount code issued independently of
      marketing consent, enforced in the page, the RPC and the schema comments.
      Any AXRIK client running a pre-launch list needs this and it is not in the
      kit. Strong candidate for a new blueprint.
- [ ] **`public_settings()` pattern.** A single function exposing a whitelisted
      subset of `app_settings` to anon, so page copy and offers change without a
      redeploy. Generalises cleanly.
- [ ] **Assessment / quiz capture.** Question bank as data, answers as `jsonb`,
      one row per completion, admin breakdown tables generated from the keys.
      Reusable anywhere a client wants to qualify a lead.
- [ ] **Social studio.** Brief plus recent posts as voice examples, brand rules
      pulled from `app_settings` rather than hardcoded, template fallback. The
      kit has the recipe in the AI blueprint but not the working screen.
- [ ] **Anonymous page-view counting with no cookie banner.** No IP, no cookie,
      no localStorage — worth writing up as a blueprint since it removes a whole
      compliance conversation.

## What broke or took too long

- [ ] Conventions drifted before the kit was consulted — the first build of this
      used JWT metadata for roles and a `settings` table, and had to be redone as
      `user_profiles` + `current_user_role()` + `app_settings`. **Lesson: read the
      kit before writing the first migration, not after.**
- [ ]
- [ ]

## What pattern should change in the kit

- [ ] Consider whether `002_roles_and_rls.sql` should ship with the role CHECK
      already listing four roles rather than two, since every project so far has
      needed to widen it.
- [ ]

## Numbers worth recording

| | |
|---|---|
| Hours to go-live | |
| Migrations run | 3 |
| Migrations that were rework | 0 |
| Visit → signup rate, first week | |
| Visit → assessment completion, first week | |
| Share who also ticked marketing consent | |
