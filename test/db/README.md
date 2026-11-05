# Database checks

Plain SQL checks for the rules the database enforces, run against a local
Postgres with a small stand-in for Supabase's `auth` and `storage` schemas.

```
createdb packet_test
psql -d packet_test -f test/db/supabase-stub.sql
for f in supabase/0*.sql; do psql -v ON_ERROR_STOP=1 -d packet_test -f "$f"; done
psql -d packet_test -f test/db/017_onboarding.test.sql   # every line should say PASS
```

For Claude and tooling. Nothing here touches the live project.
