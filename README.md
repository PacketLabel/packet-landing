# Packet — pre-launch site and admin

Holding page for packetlabel.com with email capture and a five-question
assessment that issues a 10% discount code, plus a single-file admin app.

Built from the **AXRIK starter kit v1.1.0 under written licence**. Packet owns
this repository and the software in it; AXRIK owns the generic kit. Improvements
that are not Packet-specific go back to the kit — see `HARVEST.md`.

> This file is for Claude and tooling. The version Phil reads is
> `05 Build/Packet-Going-Live.docx`.

Stack: vanilla HTML/JS · Supabase (Postgres + RLS + Auth) · Netlify. No build step.

## Layout

```
config.example.js       Copy to config.js, add Supabase URL/anon key + branding
config.js               Committed on purpose — see the note in it
netlify.toml            Publish root, functions dir, redirects, security headers
website/
  index.html            Landing page — two choices: signup, or the assessment
  assessment.html       Five questions, issues the discount code
  privacy.html          Privacy notice. Controller is Phil Munro until the company exists
  unsubscribe.html      Token-based one-click unsubscribe, no login
  assets/               Wordmark and badge
admin/
  index.html            Single-file admin, showPage() router, Supabase Auth
  sw.js                 Network-first service worker (this is what makes it installable)
  site.webmanifest      PWA manifest
  assets/
supabase/
  001_base_schema.sql       Tables, triggers, app_settings seed
  002_roles_and_rls.sql     user_profiles + current_user_role() + every policy
  003_public_functions.sql  The five functions anon may execute
  004_code_email.sql        code_emailed_at bookkeeping + sender identity settings
netlify-functions/
  ai.js                 Generic Claude proxy — every AI feature goes through it
  manage-users.js       Owner self-manages logins (service-role, owner-gated)
  send-code.js          Emails the discount code via Resend (service-role, verified)
HARVEST.md              Go-live retro; feeds reusable wins back into the kit
```

## Deliberately NOT carried over from the kit

- **`place_order` RPC and catalogue tables.** Shopify owns products, cart,
  checkout, payment and tax. Two systems disagreeing about what an order is was
  ruled out in `01 Decisions`.
- **`portal-update.js` and the AXRIK client portal.** Packet is not an AXRIK
  client — it is a separate company that licences the kit. Keeping it out keeps
  that line clean.
- **PWA on the public site.** The holding page is disposable and gets deleted
  when the Shopify storefront arrives. Nobody installs a holding page. The admin
  app is installable because it survives.

## Security model

The public site has **no direct table access**. Anon holds `EXECUTE` on exactly
five `SECURITY DEFINER` functions — `subscribe`, `unsubscribe`, `log_view`,
`public_settings`, `complete_assessment` — and nothing else. There is no anon
`SELECT` policy anywhere, so the anon key in the page source cannot read or
enumerate subscribers, answers or codes.

Admin reads are gated by RLS through `current_user_role()`, which reads
`user_profiles` rather than the JWT. A role change therefore applies on the next
page load instead of after a sign-out.

`config.js` **is** committed. The anon key is public by design and there is no
build step to inject it. The `service_role` key must never appear in this folder —
it lives only in Netlify environment variables, for `manage-users.js`.

## The consent separation — do not "simplify" this

The discount code and the marketing tick box are independent. Someone who leaves
the box unticked still gets their code. It is enforced in the page, in
`complete_assessment()`, and commented at the top of `003`. The soft opt-in does
not cover prospective customers, so the whole list runs on express consent.

## Environment variables (Netlify)

| Variable | Needed by | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ai.js` | Social studio falls back to templates. Nothing breaks. |
| `SUPABASE_URL` | `manage-users.js`, `send-code.js` | Users page says not configured; no code emails |
| `SUPABASE_SERVICE_ROLE_KEY` | `manage-users.js`, `send-code.js` | Users page says not configured; no code emails |
| `RESEND_API_KEY` | `send-code.js` | Code shows on screen but is never emailed |

## Emailing the code

`send-code.js` is a public endpoint, so it verifies before it sends: the email
**and** the code must match the same row in `assessments`, and `code_emailed_at`
must be null. It cannot be used to send mail to anyone who has not just finished
the assessment, and it cannot send twice. On failure it records the reason in
`code_email_error`, which the admin's Assessment page surfaces.

That email is **transactional**, not marketing — it goes to everyone who
finishes, tick box or not, because they asked for a code. Do not add offers or
product news to that template. The moment it promotes anything, it becomes
marketing and needs consent that the unticked half have not given.

Sending is fire-and-forget from the page, deliberately: the code is issued and
saved before the send is attempted, so a Resend outage can never stop someone
getting what they were promised.
