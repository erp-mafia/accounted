-- Set up a gnubok test company that mirrors the testredovisare
-- Skatteverket has wired for your test BankID.
--
-- Replace the three placeholders below before running:
--   :user_id: auth.users.id of the dev user signed in to gnubok
--                              (your gnubok login email's user row)
--   :org_number_10digit: the 10-digit form of the testredovisare SKV gave you
--                              (e.g. if SKV says 165020000013, use 5020000013)
--   :entity_type: 'aktiebolag' (16-prefix) or 'enskild_firma' (19/20-prefix)
--
-- Run with: psql "$DATABASE_URL" -v user_id="'<uuid>'" -v org_number_10digit="'5020000013'" -v entity_type="'aktiebolag'" -f scripts/setup-skv-test-company.sql

\set ON_ERROR_STOP on
begin;

-- 1. Create the test company.
insert into public.companies (name, org_number, entity_type, created_by)
values ('SKV Test Company', :org_number_10digit, :entity_type, :user_id)
returning id as new_company_id \gset

-- 2. Add the dev user as owner.
insert into public.company_members (company_id, user_id, role)
values (:'new_company_id', :user_id, 'owner');

-- 3. Make this the user's active company.
insert into public.user_preferences (user_id, active_company_id)
values (:user_id, :'new_company_id')
on conflict (user_id) do update set active_company_id = excluded.active_company_id;

-- 4. Seed the BAS chart of accounts (provides 2611, 2641, 4515, etc.).
select public.seed_chart_of_accounts(:'new_company_id', :entity_type);

commit;

\echo
\echo Test company created:
\echo   company_id: :new_company_id
\echo   org_number: :org_number_10digit
\echo
\echo Next: seed VAT data with
\echo   npx tsx scripts/seed-skv-test-data.ts :new_company_id 2026 3
