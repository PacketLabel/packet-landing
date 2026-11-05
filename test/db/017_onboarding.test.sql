\set ON_ERROR_STOP 1
SET client_min_messages = warning;
-- people
INSERT INTO auth.users (id,email) VALUES ('00000000-0000-0000-0000-00000000000a','phil@packet');
UPDATE user_profiles SET role='owner' WHERE id='00000000-0000-0000-0000-00000000000a';
INSERT INTO brands (id,name,website,status) VALUES ('11111111-1111-1111-1111-111111111111','Sample Co','https://sample.example','invited'),
  ('22222222-2222-2222-2222-222222222222','Dublin Knits','https://dk.example','invited');
UPDATE brands SET outlet_commission_offered_pct=20, outlet_discount_pct=40, outlet_auto_list=true WHERE id='11111111-1111-1111-1111-111111111111';
UPDATE brands SET outlet_commission_offered_pct=15 WHERE id='22222222-2222-2222-2222-222222222222';
INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES
 ('00000000-0000-0000-0000-0000000000b1','ann@sample','{"packet_role":"brand","brand_id":"11111111-1111-1111-1111-111111111111"}'),
 ('00000000-0000-0000-0000-0000000000b2','ciara@dk','{"packet_role":"brand","brand_id":"22222222-2222-2222-2222-222222222222"}');
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', u, false), set_config('request.jwt.claims', '{}', false) $$;
CREATE TABLE pg_temp.res (n text, ok boolean, info text); GRANT ALL ON pg_temp.res TO anon, authenticated;

-- Brand 1
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
SET ROLE authenticated;
DO $$ DECLARE j jsonb; BEGIN
  j := my_brand();
  INSERT INTO pg_temp.res VALUES ('my_brand offered 20', (j->>'offered_pct')::numeric = 20, j::text);
  INSERT INTO pg_temp.res VALUES ('terms needed', (j->>'terms_needed')::boolean, '');
  INSERT INTO pg_temp.res VALUES ('no published terms', j->'terms' = 'null'::jsonb OR j->'terms' IS NULL, '');
  BEGIN PERFORM brand_accept_terms('v1','Ann Smith','Director',''); INSERT INTO pg_temp.res VALUES ('accept draft refused', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('accept draft refused', SQLERRM ~ 'not published', SQLERRM); END;
  BEGIN PERFORM brand_save_details('{"legal_name":"Sample Co Ltd","returns_address":"1 High St, Leeds LS1 1AA","dispatch_days":"2"}');
    INSERT INTO pg_temp.res VALUES ('details saved', true, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('details saved', false, SQLERRM); END;
  BEGIN PERFORM brand_save_details('{"legal_name":"X","returns_address":"short","dispatch_days":"2"}');
    INSERT INTO pg_temp.res VALUES ('short address refused', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('short address refused', true, SQLERRM); END;
  -- can't see other brand / brands table
  INSERT INTO pg_temp.res VALUES ('brand cannot read brands', (SELECT count(*) FROM brands) = 0, '');
  INSERT INTO pg_temp.res VALUES ('brand cannot read applications', (SELECT count(*) FROM brand_applications) = 0, '');
  INSERT INTO pg_temp.res VALUES ('brand cannot read terms table', (SELECT count(*) FROM outlet_terms) = 0, '');
  -- item submitted before terms: stays submitted (no commission)
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,quantity,status,photos) VALUES ('Card A','new_with_tags',3000,8900,2,'submitted','["https://x/p.jpg"]');
  INSERT INTO pg_temp.res VALUES ('pre-terms item waits', (SELECT status FROM outlet_items WHERE title='Card A')='submitted', '');
END $$;
RESET ROLE;

-- Owner publishes v1, tries to edit it
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
SET ROLE authenticated;
DO $$ BEGIN
  UPDATE outlet_terms SET body = replace(body, 'DRAFT', 'Checked'), published_at = now() WHERE version='v1';
  INSERT INTO pg_temp.res VALUES ('owner published', (SELECT published_at IS NOT NULL FROM outlet_terms WHERE version='v1'), '');
  BEGIN UPDATE outlet_terms SET body='changed' WHERE version='v1'; INSERT INTO pg_temp.res VALUES ('published locked', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('published locked', true, SQLERRM); END;
  BEGIN UPDATE outlet_items SET status='live', sale_minor=5000 WHERE title='Card A'; INSERT INTO pg_temp.res VALUES ('live before terms blocked', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('live before terms blocked', SQLERRM ~ 'terms', SQLERRM); END;
END $$;
RESET ROLE;

-- Brand 1 accepts; then auto-lists
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
SET ROLE authenticated;
DO $$ DECLARE j jsonb; BEGIN
  j := brand_accept_terms('v1','Ann Smith','Director','UA');
  INSERT INTO pg_temp.res VALUES ('accepted 20', (j->>'commission_pct')::numeric = 20, j::text);
  j := my_brand();
  INSERT INTO pg_temp.res VALUES ('terms no longer needed', NOT (j->>'terms_needed')::boolean, '');
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,quantity,status,photos) VALUES ('Card B','new_with_tags',3000,8900,1,'submitted','["https://x/p.jpg"]');
  INSERT INTO pg_temp.res VALUES ('auto-listed at 40% off rounded', (SELECT status||':'||sale_minor FROM outlet_items WHERE title='Card B')='live:5300',
     (SELECT status||':'||sale_minor FROM outlet_items WHERE title='Card B'));
  INSERT INTO outlet_items (title,condition,condition_note,floor_minor,rrp_minor,quantity,status,photos) VALUES ('Card C','minor_fault','pull',3000,8900,1,'submitted','["https://x/p.jpg"]');
  INSERT INTO pg_temp.res VALUES ('fault waits for a person', (SELECT status FROM outlet_items WHERE title='Card C')='submitted', '');
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,quantity,status) VALUES ('Card D','new_with_tags',3000,8900,1,'submitted');
  INSERT INTO pg_temp.res VALUES ('no photo waits', (SELECT status FROM outlet_items WHERE title='Card D')='submitted', '');
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,quantity,status,photos) VALUES ('Card E','new_with_tags',6000,8900,1,'submitted','["https://x/p.jpg"]');
  INSERT INTO pg_temp.res VALUES ('never below floor', (SELECT sale_minor FROM outlet_items WHERE title='Card E')=6000, '');
  BEGIN UPDATE outlet_items SET status='live' WHERE title='Card C'; INSERT INTO pg_temp.res VALUES ('brand still cannot list', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('brand still cannot list', true, SQLERRM); END;
  INSERT INTO pg_temp.res VALUES ('brand cannot read agreements', (SELECT count(*) FROM brand_agreements)=0, '');
END $$;
RESET ROLE;

-- Brand 2 (Ireland)
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM brand_save_details('{"legal_name":"Dublin Knits Ltd","country":"IE","returns_address":"2 Quay St, Dublin D02","dispatch_days":3}');
  PERFORM brand_accept_terms('v1','Ciara Byrne','Owner','');
  INSERT INTO outlet_items (title,condition,floor_minor,quantity,status) VALUES ('Aran jumper','new_with_tags',4000,1,'submitted');
  INSERT INTO pg_temp.res VALUES ('brand 2 sees only own items', (SELECT count(*) FROM outlet_items)=1, '');
END $$;
RESET ROLE;

SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
SET ROLE authenticated;
DO $$ DECLARE j jsonb; BEGIN
  BEGIN UPDATE outlet_items SET status='live', sale_minor=5000 WHERE title='Aran jumper'; INSERT INTO pg_temp.res VALUES ('cross-border blocked', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('cross-border blocked', SQLERRM ~ 'outside Great Britain', SQLERRM); END;
  j := outlet_list_at_suggested(ARRAY(SELECT id FROM outlet_items WHERE status='submitted'));
  INSERT INTO pg_temp.res VALUES ('bulk: lists Card A, C, D; skips Aran (no discount)', (j->>'listed')::int = 3 AND jsonb_array_length(j->'skipped')=1, j::text);
  UPDATE brands SET cross_border_ok = true WHERE name='Dublin Knits';
  UPDATE outlet_items SET status='live', sale_minor=5000 WHERE title='Aran jumper';
  INSERT INTO pg_temp.res VALUES ('cross-border after tick', (SELECT status FROM outlet_items WHERE title='Aran jumper')='live', '');
  INSERT INTO pg_temp.res VALUES ('agreement recorded with wording', (SELECT count(*) FROM brand_agreements WHERE terms_body ~ 'Checked')=2, '');
  INSERT INTO pg_temp.res VALUES ('summary view', (SELECT n_live FROM outlet_brand_summary WHERE name='Sample Co')=5, (SELECT n_live::text FROM outlet_brand_summary WHERE name='Sample Co'));
  INSERT INTO pg_temp.res VALUES ('terms source', (SELECT outlet_terms_source FROM brands WHERE name='Sample Co') ~ 'Accepted online: terms v1, 20%, by Ann Smith', (SELECT outlet_terms_source FROM brands WHERE name='Sample Co'));
  -- order on auto-listed brand pays at 20%
  INSERT INTO outlet_orders (item_id, item_title, order_ref, sale_minor, customer_name, ship_line1, ship_town, ship_postcode)
    SELECT id, '', 'T1', 5300, 'A', 'B', 'C', 'D' FROM outlet_items WHERE title='Card B';
  INSERT INTO pg_temp.res VALUES ('payout at accepted 20%', (SELECT payout_minor FROM outlet_orders WHERE order_ref='T1')=4240, '');
END $$;
RESET ROLE;
-- anon: nothing
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM count(*) FROM brand_applications; INSERT INTO pg_temp.res VALUES ('anon blocked from applications', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('anon blocked from applications', true, ''); END;
  BEGIN PERFORM my_brand(); INSERT INTO pg_temp.res VALUES ('anon cannot call my_brand', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('anon cannot call my_brand', true, ''); END;
END $$;
RESET ROLE;
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, n, CASE WHEN ok THEN '' ELSE info END FROM pg_temp.res;
