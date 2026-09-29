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
- [ ] **Seasonal calendar engine (`packet-seasons.js`).** Date rules rather than
      dates, so Easter, Mothering Sunday, Black Friday and Father's Day stay
      right every year instead of for one, plus the backwards-from-the-event
      lead time maths. Any client selling anything dated needs this and none of
      it is domain-specific. Strong kit candidate.
- [ ] **Propose / confirm / apply assistant.** A natural-language box over a
      hard allow-list: the model proposes, ordinary code validates and writes
      the plain-English preview, a human confirms, and the boundary is a CHECK
      constraint rather than a prompt. The generalisable part is the SHAPE —
      three separate steps, with the preview generated from the validated
      actions rather than from the model's prose. Every client eventually asks
      "can I just tell it what to do", and this is the answer that does not end
      with an AI editing a price. Best kit candidate on this list.

- [ ] **Outside-party login (Outlet brands, 014).** A second audience signing into
      the same Supabase project, kept to its own rows by RLS plus a guard trigger for
      the columns RLS cannot protect, a separate page file so they never download
      the staff app, and personal data handed over only through a SECURITY DEFINER
      function that stops showing an address 30 days after it is needed. Any client
      with suppliers, trade customers or partners logging in needs this shape.

## What broke or took too long
- [ ] **Views without `security_invoker` leak through RLS** (found 29 Sept 2026).
      Five views were readable by any signed-in account because a plain view runs
      as its owner. Harmless while only staff could sign in; the first outside login
      would have read supplier cost prices. **Kit rule: every view is created
      `WITH (security_invoker = true)`, and a test checks it.**
- [ ] **`ai.js` answered anyone** (found 29 Sept 2026). The kit's AI proxy had no
      caller check, so anyone who found the URL could spend the client's Anthropic
      key. Fixed here to accept only owner/staff logins or the service key from the
      site's own functions. **Promote to the kit — every client has this hole.**
- [ ] **`current_user_role()` falling back to 'staff'** is only least privilege
      while every login is an employee. 014 adds an app-metadata stamp checked
      before the fallback. The kit should fall back to no role at all.

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
- [ ] The price screen (`price-check.js` + `012_price_checks.sql`) is not
      Packet-specific. Any client reselling goods somebody else already sells
      needs "what does this cost us against what it already sells for", and the
      cheapest-route-first shape — read a Shopify feed for free, fall back to a
      paid web search only when that fails — is the reusable part. So is
      refusing to judge when no target is set.
- [ ]

## Numbers worth recording

| | |
|---|---|
| Hours to go-live | |
| Migrations run | 12 |
| Migrations that were rework | 0 |
| Visit → signup rate, first week | |
| Visit → assessment completion, first week | |
| Share who also ticked marketing consent | |
