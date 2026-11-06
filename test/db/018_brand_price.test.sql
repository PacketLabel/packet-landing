\set ON_ERROR_STOP 1
SET client_min_messages = warning;
INSERT INTO auth.users (id,email) VALUES ('00000000-0000-0000-0000-0000000000aa','owner@packet');
UPDATE user_profiles SET role='owner' WHERE id='00000000-0000-0000-0000-0000000000aa';
INSERT INTO brands (id,name,website,status,outlet_commission_pct) VALUES ('33333333-3333-3333-3333-333333333333','Price Co','https://price.example','invited',15);
INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('00000000-0000-0000-0000-0000000000c1','b@price','{"packet_role":"brand","brand_id":"33333333-3333-3333-3333-333333333333"}');
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false), set_config('request.jwt.claims', '{}', false) $$;
CREATE TABLE pg_temp.res (n text, ok boolean, info text); GRANT ALL ON pg_temp.res TO anon, authenticated;

SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
SET ROLE authenticated;
DO $$ DECLARE j jsonb; BEGIN
  PERFORM brand_set_discount(20);
  j := my_brand();
  INSERT INTO pg_temp.res VALUES ('brand sets usual discount', (j->>'brand_discount_pct')::numeric = 20, j::text);
  BEGIN PERFORM brand_set_discount(120); INSERT INTO pg_temp.res VALUES ('silly discount refused', false, '');
  EXCEPTION WHEN others THEN INSERT INTO pg_temp.res VALUES ('silly discount refused', true, SQLERRM); END;
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,quantity,status) VALUES ('A','new_with_tags',5000,9500,1,'submitted');
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,brand_price_minor,quantity,status) VALUES ('B','new_with_tags',5000,9500,7000,1,'submitted');
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,brand_price_minor,quantity,status) VALUES ('C','new_with_tags',5000,9500,3000,1,'submitted');
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,quantity,status,sale_minor) VALUES ('D','new_with_tags',5000,9500,1,'submitted',100);
  INSERT INTO pg_temp.res VALUES ('asking price below lowest raised to lowest', (SELECT brand_price_minor FROM outlet_items WHERE title='C')=5000, '');
  INSERT INTO pg_temp.res VALUES ('brand still cannot set the sale price', (SELECT sale_minor FROM outlet_items WHERE title='D') IS NULL, '');
END $$;
RESET ROLE;
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000aa');
SET ROLE authenticated;
DO $$ DECLARE j jsonb; BEGIN
  INSERT INTO pg_temp.res VALUES ('suggest: item price first', outlet_item_suggest('33333333-3333-3333-3333-333333333333',9500,5000,7000)=7000, '');
  INSERT INTO pg_temp.res VALUES ('suggest: then brand usual 20% (95 -> 76)', outlet_item_suggest('33333333-3333-3333-3333-333333333333',9500,5000,NULL)=7600, '');
  UPDATE brands SET outlet_discount_pct = 40 WHERE name='Price Co';
  INSERT INTO pg_temp.res VALUES ('brand usual beats Packet discount', outlet_item_suggest('33333333-3333-3333-3333-333333333333',9500,5000,NULL)=7600, '');
  j := outlet_list_at_suggested(ARRAY(SELECT id FROM outlet_items WHERE title IN ('A','B','C')));
  INSERT INTO pg_temp.res VALUES ('bulk lists 3', (j->>'listed')::int=3, j::text);
  INSERT INTO pg_temp.res VALUES ('prices used: A 76, B 70, C 50', (SELECT string_agg(title||sale_minor, ',' ORDER BY title) FROM outlet_items WHERE title IN ('A','B','C'))='A7600,B7000,C5000',
     (SELECT string_agg(title||sale_minor, ',' ORDER BY title) FROM outlet_items WHERE title IN ('A','B','C')));
  UPDATE brands SET outlet_auto_list = true WHERE name='Price Co';
END $$;
RESET ROLE;
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO outlet_items (title,condition,floor_minor,rrp_minor,brand_price_minor,quantity,status,photos) VALUES ('E','new_with_tags',2000,6000,4500,1,'submitted','["https://x/p.jpg"]');
  INSERT INTO pg_temp.res VALUES ('trusted brand: lists itself at its own price', (SELECT status||':'||sale_minor FROM outlet_items WHERE title='E')='live:4500', (SELECT status||':'||sale_minor FROM outlet_items WHERE title='E'));
END $$;
RESET ROLE;
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, n, CASE WHEN ok THEN '' ELSE info END FROM pg_temp.res;
