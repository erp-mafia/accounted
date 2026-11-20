-- One synthetic company for the report benchmark. THROWAWAY DATABASE ONLY:
-- posted rows are written straight into the tables (as tests/pg/upgrade/seed.sql
-- does), never a pattern for a real database. Included by seed.sql, which sets:
--   co, uid, email, company_name, org_number  identity
--   company_per_year                          verifikat per fiscal year
--   rnd_seed                                  setseed() value, in [-1, 1]
--
-- Shape: fiscal years 2024 and 2025 closed and locked, 2026 open, each year
-- company_per_year verifikat (2026 between 1 January and the bench day
-- 2026-10-22) at about 3 lines each, about 200 accounts with activity, and
-- dimension tags on about a quarter of the lines. Like the largest companies
-- in production, no year has an IB verifikat linked
-- (fiscal_periods.opening_balance_entry_id is NULL): 2024 opens with an
-- unlinked opening_balance verifikat, and 2025 and 2026 open from the years
-- before them, so every report reads its IB through
-- compute_prior_opening_balances. Around the
-- journal: invoices and their payments, supplier invoices with documents,
-- bank transactions (booked and an unbooked queue), receipts, payroll,
-- storno chains, monthly VAT settlements, year-end closings and opening
-- balances. Verifikat, line and register ids come from md5 and every random()
-- call follows setseed(), so the same parameters give the same ledger (the
-- surrogate ids of child rows such as audit rows and invoice items come from
-- their uuid defaults).

\set today '2026-10-22'

SET max_parallel_workers_per_gather = 0;

CREATE OR REPLACE FUNCTION pg_temp.uid(k text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5(k)::uuid $$;

-- Log-uniform amount between lo and hi.
CREATE OR REPLACE FUNCTION pg_temp.amt(lo float8, hi float8) RETURNS numeric
LANGUAGE sql VOLATILE AS $$ SELECT round(exp(ln(lo) + random() * (ln(hi) - ln(lo)))::numeric, 2) $$;

-- Dimension bag for a P&L line: about three in four tagged, a third of
-- those with a project as well, which lands near 25 % of all lines.
CREATE OR REPLACE FUNCTION pg_temp.dims() RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN r < 0.26 THEN '{}'::jsonb
              WHEN r < 0.74 THEN jsonb_build_object('1', 'KS' || lpad((1 + floor(random() * 12))::int::text, 2, '0'))
              ELSE jsonb_build_object('1', 'KS' || lpad((1 + floor(random() * 12))::int::text, 2, '0'),
                                      '6', 'P' || lpad((1 + floor(random() * 60))::int::text, 3, '0')) END
  FROM (SELECT random() AS r) s $$;

-- A day in fiscal year fy; the open year 2026 ends on the bench day.
CREATE OR REPLACE FUNCTION pg_temp.fy_date(fy int) RETURNS date
LANGUAGE sql VOLATILE AS $$
  SELECT make_date(fy, 1, 1) + floor(random() * (CASE WHEN fy = 2026 THEN 295 ELSE make_date(fy, 12, 31) - make_date(fy, 1, 1) + 1 END))::int $$;

-- When the verifikat was registered: the same day or, one time in five, two days later.
CREATE OR REPLACE FUNCTION pg_temp.ts(d date) RETURNS timestamptz
LANGUAGE sql VOLATILE AS $$
  SELECT (d + time '07:30' + (floor(random() * 600) || ' minutes')::interval)::timestamptz
         + CASE WHEN random() < 0.2 THEN interval '2 days' ELSE interval '0' END $$;

CREATE OR REPLACE FUNCTION pg_temp.fp(co uuid, fy int) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT pg_temp.uid(co || ':fp:' || fy) $$;

-- ========================================================================
-- Company, settings, chart, periods, dimensions, parties, bank account
-- ========================================================================
BEGIN;
SELECT setseed(:rnd_seed) AS seeded \gset

INSERT INTO auth.users (id, email, instance_id, aud, role)
VALUES (:'uid'::uuid, :'email', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

INSERT INTO companies (id, name, org_number, entity_type, created_by, created_at)
VALUES (:'co'::uuid, :'company_name', :'org_number', 'aktiebolag', :'uid'::uuid, '2023-11-15 10:00+01');

INSERT INTO company_members (company_id, user_id, role) VALUES (:'co'::uuid, :'uid'::uuid, 'owner');

INSERT INTO company_settings (company_id, user_id, entity_type, company_name, org_number, vat_number,
  address_line1, postal_code, city, vat_registered, moms_period, fiscal_year_start_month,
  onboarding_complete, accounting_method, initial_setup_completed_at, dimensions_enabled,
  pays_salaries, employer_registered, f_skatt, bankgiro, invoice_prefix, next_invoice_number,
  next_arrival_number)
VALUES (:'co'::uuid, :'uid'::uuid, 'aktiebolag', :'company_name', :'org_number', 'SE' || :'org_number' || '01',
  'Testgatan 1', '11122', 'Stockholm', true, 'monthly', 1,
  true, 'accrual', '2023-11-20 10:00+01', true,
  true, true, true, '123-4567', '', 100001, 30001);

INSERT INTO user_preferences (user_id, active_company_id) VALUES (:'uid'::uuid, :'co'::uuid)
ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

SELECT seed_chart_of_accounts(:'co'::uuid, 'aktiebolag') AS chart \gset

-- The accounts the generated flows book on.
INSERT INTO chart_of_accounts (user_id, company_id, account_number, account_name, account_class,
  account_group, account_type, normal_balance, plan_type)
SELECT :'uid'::uuid, :'co'::uuid, a.n, a.name, left(a.n, 1)::int, left(a.n, 2),
  CASE WHEN a.n < '2000' THEN 'asset' WHEN a.n < '2100' THEN 'equity' WHEN a.n < '2200' THEN 'untaxed_reserves'
       WHEN a.n < '3000' THEN 'liability' WHEN a.n < '4000' THEN 'revenue' ELSE 'expense' END,
  CASE WHEN a.n < '2000' OR a.n >= '4000' THEN 'debit' ELSE 'credit' END,
  'full_bas'
FROM (VALUES
  ('1220','Inventarier och verktyg'),('1229','Ackumulerade avskrivningar på inventarier'),
  ('1460','Lager av handelsvaror'),('1510','Kundfordringar'),('1610','Kortfristiga fordringar hos anställda'),
  ('1630','Avräkning för skatter och avgifter (skattekonto)'),('1650','Momsfordran'),
  ('1710','Förutbetalda hyreskostnader'),('1790','Övriga förutbetalda kostnader'),('1930','Företagskonto'),
  ('2081','Aktiekapital'),('2091','Balanserad vinst eller förlust'),('2098','Vinst eller förlust från föregående år'),
  ('2099','Årets resultat'),('2440','Leverantörsskulder'),('2510','Skatteskulder'),('2512','Beräknad inkomstskatt'),
  ('2611','Utgående moms på försäljning inom Sverige, 25 %'),('2621','Utgående moms på försäljning inom Sverige, 12 %'),
  ('2631','Utgående moms på försäljning inom Sverige, 6 %'),('2641','Debiterad ingående moms'),
  ('2650','Redovisningskonto för moms'),('2710','Personalskatt'),('2731','Avräkning lagstadgade sociala avgifter'),
  ('2893','Skulder till närstående personer, kortfristig del'),('2920','Upplupna semesterlöner'),
  ('2940','Upplupna lagstadgade sociala och andra avgifter'),('2990','Övriga upplupna kostnader'),
  ('3001','Försäljning inom Sverige, 25 % moms'),('3002','Försäljning inom Sverige, 12 % moms'),
  ('3003','Försäljning inom Sverige, 6 % moms'),('3041','Försäljning tjänst inom Sverige, 25 % moms'),
  ('3305','Försäljning tjänster till land utanför EU'),('4010','Inköp material och varor'),
  ('5010','Lokalhyra'),('5410','Förbrukningsinventarier'),('5460','Förbrukningsmaterial'),
  ('5611','Drivmedel för personbilar'),('5800','Resekostnader'),('5910','Annonsering'),
  ('6071','Representation, avdragsgill'),('6110','Kontorsmateriel'),('6212','Mobiltelefon'),
  ('6230','Datakommunikation'),('6530','Redovisningstjänster'),('6540','IT-tjänster'),('6570','Bankkostnader'),
  ('6991','Övriga externa kostnader, avdragsgilla'),('7210','Löner till tjänstemän'),
  ('7290','Förändring av semesterlöneskuld'),('7510','Arbetsgivaravgifter 31,42 %'),
  ('7519','Sociala avgifter för semester- och löneskulder'),('7832','Avskrivningar på inventarier och verktyg'),
  ('8310','Ränteintäkter från omsättningstillgångar'),('8410','Räntekostnader för långfristiga skulder'),
  ('8910','Skatt som belastar årets resultat'),('8999','Årets resultat')
) AS a(n, name)
ON CONFLICT (company_id, account_number) DO NOTHING;

-- The long tail the manual verifikat book on: 160 more accounts across
-- classes 1 and 3 to 8, clear of the VAT, receivable, payable, cash, equity
-- and result ranges the flows above own.
CREATE TEMP TABLE tail_account ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY n) AS k, n::text AS account_number
FROM (
  SELECT n FROM generate_series(1020, 1490, 30) n
  UNION ALL SELECT n FROM generate_series(3110, 3990, 40) n
  UNION ALL SELECT n FROM generate_series(4110, 4990, 40) n
  UNION ALL SELECT n FROM generate_series(5020, 5990, 30) n
  UNION ALL SELECT n FROM generate_series(6020, 6990, 30) n
  UNION ALL SELECT n FROM generate_series(7020, 7990, 40) n
  UNION ALL SELECT n FROM generate_series(8020, 8890, 30) n
) s;
INSERT INTO chart_of_accounts (user_id, company_id, account_number, account_name, account_class,
  account_group, account_type, normal_balance, plan_type)
SELECT :'uid'::uuid, :'co'::uuid, t.account_number, 'Konto ' || t.account_number, left(t.account_number, 1)::int,
  left(t.account_number, 2),
  CASE WHEN t.account_number < '2000' THEN 'asset' WHEN t.account_number < '4000' THEN 'revenue' ELSE 'expense' END,
  CASE WHEN t.account_number < '2000' OR t.account_number >= '4000' THEN 'debit' ELSE 'credit' END,
  'full_bas'
FROM tail_account t
ON CONFLICT (company_id, account_number) DO NOTHING;
CREATE TEMP TABLE bench_tail_account AS SELECT * FROM tail_account;

INSERT INTO fiscal_periods (id, user_id, company_id, name, period_start, period_end, is_closed, created_at)
SELECT pg_temp.fp(:'co'::uuid, fy), :'uid'::uuid, :'co'::uuid, fy::text, make_date(fy, 1, 1), make_date(fy, 12, 31), false,
       make_timestamptz(fy - 1, 11, 20, 10, 0, 0, 'Europe/Stockholm')
FROM generate_series(2024, 2026) fy;
UPDATE fiscal_periods SET previous_period_id = pg_temp.fp(:'co'::uuid, 2024) WHERE id = pg_temp.fp(:'co'::uuid, 2025);
UPDATE fiscal_periods SET previous_period_id = pg_temp.fp(:'co'::uuid, 2025) WHERE id = pg_temp.fp(:'co'::uuid, 2026);

INSERT INTO dimensions (id, company_id, sie_dim_no, name)
VALUES (pg_temp.uid(:'co'::uuid || ':dim:1'), :'co'::uuid, 1, 'Kostnadsställe'),
       (pg_temp.uid(:'co'::uuid || ':dim:6'), :'co'::uuid, 6, 'Projekt');
INSERT INTO dimension_values (company_id, dimension_id, code, name)
SELECT :'co'::uuid, pg_temp.uid(:'co'::uuid || ':dim:1'), 'KS' || lpad(g::text, 2, '0'), 'Kostnadsställe ' || g
FROM generate_series(1, 12) g
UNION ALL
SELECT :'co'::uuid, pg_temp.uid(:'co'::uuid || ':dim:6'), 'P' || lpad(g::text, 3, '0'), 'Projekt ' || g
FROM generate_series(1, 60) g;

INSERT INTO customers (id, user_id, company_id, name, org_number, email, customer_type, customer_number, created_at)
SELECT pg_temp.uid(:'co'::uuid || ':cust:' || g), :'uid'::uuid, :'co'::uuid,
       'Kund ' || g || ' AB', '55' || lpad((10000000 + g)::text, 8, '0'), 'kund' || g || '@example.invalid',
       CASE WHEN g % 40 = 0 THEN 'non_eu_business' ELSE 'swedish_business' END, g::text,
       '2023-12-01 10:00+01'::timestamptz + (g || ' hours')::interval
FROM generate_series(1, 1500) g;

INSERT INTO suppliers (id, user_id, company_id, name, org_number, bankgiro, default_expense_account, created_at)
SELECT pg_temp.uid(:'co'::uuid || ':supp:' || g), :'uid'::uuid, :'co'::uuid,
       'Leverantör ' || g || ' AB', '55' || lpad((20000000 + g)::text, 8, '0'), lpad(g::text, 7, '0'),
       (ARRAY['4010','5010','5410','5460','6110','6230','6540','6530','5910','6991'])[1 + g % 10],
       '2023-12-01 10:00+01'::timestamptz + (g || ' hours')::interval
FROM generate_series(1, 400) g;

INSERT INTO cash_accounts (id, company_id, name, currency, ledger_account, is_primary, source, iban, bank_name)
VALUES (pg_temp.uid(:'co'::uuid || ':cash'), :'co'::uuid, 'Företagskonto', 'SEK', '1930', true, 'manual',
        'SE4550000000058398257466', 'Testbanken');
COMMIT;

-- ========================================================================
-- The plan: every verifikat and its lines in temp tables, posted below
-- ========================================================================
BEGIN;
SELECT setseed(:rnd_seed / 2) AS seeded \gset

CREATE TEMP TABLE je (
  id uuid PRIMARY KEY, fy int, entry_date date, descr text, source_type text, source_id uuid,
  kind text, created_at timestamptz, bank_ctx jsonb, reverses_id uuid,
  correction_of_id uuid, reversed_by uuid
);
CREATE TEMP TABLE jl (
  je_id uuid, account text, debit numeric NOT NULL DEFAULT 0, credit numeric NOT NULL DEFAULT 0,
  ord int, dims jsonb NOT NULL DEFAULT '{}', descr text
);
CREATE TEMP TABLE tx (
  id uuid PRIMARY KEY, tx_date date, amount numeric, descr text, je_id uuid, invoice_id uuid,
  supplier_invoice_id uuid, merchant text
);
CREATE TEMP TABLE years AS
SELECT fy, round(:company_per_year * 0.24)::int AS n_inv, round(:company_per_year * 0.08)::int AS n_sinv,
       round(:company_per_year * 0.24)::int AS n_bank, greatest(3, round(:company_per_year * 0.0012))::int AS n_chain
FROM generate_series(2024, 2026) fy;

-- ---------- customer invoices and their payments ----------
CREATE TEMP TABLE inv AS
SELECT y.fy, g AS n, pg_temp.uid(:'co'::uuid || ':inv:' || y.fy || ':' || g) AS id,
       pg_temp.uid(:'co'::uuid || ':inv-je:' || y.fy || ':' || g) AS je_id,
       pg_temp.uid(:'co'::uuid || ':inv-pay-je:' || y.fy || ':' || g) AS pay_je,
       pg_temp.uid(:'co'::uuid || ':inv-pay-tx:' || y.fy || ':' || g) AS pay_tx,
       random() AS r_vat, 1 + floor(random() * 4)::int AS n_items, random() AS r_pay, random() AS r_cust,
       random() AS r_late
FROM years y CROSS JOIN LATERAL generate_series(1, y.n_inv) g;
ALTER TABLE inv ADD COLUMN invoice_date date, ADD COLUMN vat_pct int, ADD COLUMN customer_n int,
  ADD COLUMN subtotal numeric, ADD COLUMN vat numeric, ADD COLUMN total numeric, ADD COLUMN pay_date date,
  ADD COLUMN invoice_number text;
UPDATE inv SET invoice_date = pg_temp.fy_date(fy),
  vat_pct = CASE WHEN r_vat < 0.90 THEN 25 WHEN r_vat < 0.95 THEN 12 WHEN r_vat < 0.97 THEN 6 ELSE 0 END;
-- Export invoices go to the non-EU customers (every 40th).
UPDATE inv SET customer_n = CASE WHEN vat_pct = 0 THEN 40 * (1 + floor(r_cust * 37)::int)
                                 ELSE 1 + floor(r_cust * 1500)::int END;
UPDATE inv SET customer_n = customer_n - 1 WHERE vat_pct > 0 AND customer_n % 40 = 0;
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY invoice_date, fy, n) AS rn FROM inv)
UPDATE inv SET invoice_number = (10000 + o.rn)::text FROM ordered o WHERE o.id = inv.id;

CREATE TEMP TABLE inv_item AS
SELECT i.id AS invoice_id, k AS ord, i.vat_pct,
       CASE i.vat_pct WHEN 25 THEN CASE WHEN k % 2 = 1 THEN '3041' ELSE '3001' END
                      WHEN 12 THEN '3002' WHEN 6 THEN '3003' ELSE '3305' END AS account,
       pg_temp.amt(300, 40000) AS net, pg_temp.dims() AS dims
FROM inv i CROSS JOIN LATERAL generate_series(1, i.n_items) k;

UPDATE inv SET subtotal = s.net, vat = round(s.net * inv.vat_pct / 100.0, 2),
  total = s.net + round(s.net * inv.vat_pct / 100.0, 2)
FROM (SELECT invoice_id, sum(net) AS net FROM inv_item GROUP BY invoice_id) s WHERE s.invoice_id = inv.id;

-- 3 % never pay; the rest pay 20 to 44 days after the invoice date.
UPDATE inv SET pay_date = invoice_date + 20 + floor(r_late * 25)::int WHERE r_pay >= 0.03;
UPDATE inv SET pay_date = NULL WHERE pay_date > :'today'::date;

INSERT INTO je (id, fy, entry_date, descr, source_type, source_id, kind, created_at)
SELECT je_id, fy, invoice_date, 'Kundfaktura ' || invoice_number || ' Kund ' || customer_n || ' AB',
       'invoice_created', id, 'inv', pg_temp.ts(invoice_date)
FROM inv;
INSERT INTO jl (je_id, account, debit, ord) SELECT je_id, '1510', total, 0 FROM inv;
INSERT INTO jl (je_id, account, credit, ord, dims)
SELECT i.je_id, it.account, it.net, it.ord, it.dims FROM inv_item it JOIN inv i ON i.id = it.invoice_id;
INSERT INTO jl (je_id, account, credit, ord)
SELECT je_id, CASE vat_pct WHEN 25 THEN '2611' WHEN 12 THEN '2621' ELSE '2631' END, vat, 9
FROM inv WHERE vat_pct > 0;

INSERT INTO tx (id, tx_date, amount, descr, je_id, invoice_id)
SELECT pay_tx, pay_date, total, 'BG INBET ' || invoice_number, pay_je, id FROM inv WHERE pay_date IS NOT NULL;
INSERT INTO je (id, fy, entry_date, descr, source_type, source_id, kind, created_at, bank_ctx)
SELECT pay_je, extract(year FROM pay_date)::int, pay_date, 'Betalning kundfaktura ' || invoice_number,
       'invoice_paid', id, 'invpay', pg_temp.ts(pay_date),
       jsonb_build_array(jsonb_build_object('transaction_id', pay_tx, 'cash_account_id', pg_temp.uid(:'co'::uuid || ':cash'),
         'settlement_account', '1930', 'date', pay_date, 'amount', total, 'currency', 'SEK'))
FROM inv WHERE pay_date IS NOT NULL;
INSERT INTO jl (je_id, account, debit, ord) SELECT pay_je, '1930', total, 0 FROM inv WHERE pay_date IS NOT NULL;
INSERT INTO jl (je_id, account, credit, ord) SELECT pay_je, '1510', total, 1 FROM inv WHERE pay_date IS NOT NULL;

-- ---------- supplier invoices and their payments ----------
CREATE TEMP TABLE sinv AS
SELECT y.fy, g AS n, pg_temp.uid(:'co'::uuid || ':sinv:' || y.fy || ':' || g) AS id,
       pg_temp.uid(:'co'::uuid || ':sinv-je:' || y.fy || ':' || g) AS je_id,
       pg_temp.uid(:'co'::uuid || ':sinv-pay-je:' || y.fy || ':' || g) AS pay_je,
       pg_temp.uid(:'co'::uuid || ':sinv-pay-tx:' || y.fy || ':' || g) AS pay_tx,
       pg_temp.uid(:'co'::uuid || ':sinv-doc:' || y.fy || ':' || g) AS doc_id,
       1 + floor(random() * 400)::int AS supplier_n, 1 + floor(random() * 2.2)::int AS n_items,
       random() < 0.9 AS has_vat, random() AS r_pay
FROM years y CROSS JOIN LATERAL generate_series(1, y.n_sinv) g;
ALTER TABLE sinv ADD COLUMN invoice_date date, ADD COLUMN subtotal numeric, ADD COLUMN vat numeric,
  ADD COLUMN total numeric, ADD COLUMN pay_date date, ADD COLUMN arrival int;
UPDATE sinv SET invoice_date = pg_temp.fy_date(fy);
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY invoice_date, fy, n) AS rn FROM sinv)
UPDATE sinv SET arrival = o.rn FROM ordered o WHERE o.id = sinv.id;
CREATE TEMP TABLE sinv_item AS
SELECT s.id AS sinv_id, k AS ord,
       (ARRAY['4010','5010','5410','5460','6110','6230','6540','6530','5910','6991'])[1 + (s.supplier_n + k) % 10] AS account,
       pg_temp.amt(200, 60000) AS net, pg_temp.dims() AS dims
FROM sinv s CROSS JOIN LATERAL generate_series(1, s.n_items) k;
UPDATE sinv SET subtotal = x.net, vat = CASE WHEN has_vat THEN round(x.net * 0.25, 2) ELSE 0 END,
  total = x.net + CASE WHEN has_vat THEN round(x.net * 0.25, 2) ELSE 0 END
FROM (SELECT sinv_id, sum(net) AS net FROM sinv_item GROUP BY sinv_id) x WHERE x.sinv_id = sinv.id;
UPDATE sinv SET pay_date = invoice_date + 27 + floor(r_pay * 7)::int;
UPDATE sinv SET pay_date = NULL WHERE pay_date > :'today'::date;

INSERT INTO je (id, fy, entry_date, descr, source_type, source_id, kind, created_at)
SELECT je_id, fy, invoice_date, 'Leverantörsfaktura ' || arrival || ' Leverantör ' || supplier_n || ' AB',
       'supplier_invoice_registered', id, 'sinv', pg_temp.ts(invoice_date)
FROM sinv;
INSERT INTO jl (je_id, account, credit, ord) SELECT je_id, '2440', total, 0 FROM sinv;
INSERT INTO jl (je_id, account, debit, ord, dims)
SELECT s.je_id, it.account, it.net, it.ord, it.dims FROM sinv_item it JOIN sinv s ON s.id = it.sinv_id;
INSERT INTO jl (je_id, account, debit, ord) SELECT je_id, '2641', vat, 9 FROM sinv WHERE has_vat;

INSERT INTO tx (id, tx_date, amount, descr, je_id, supplier_invoice_id)
SELECT pay_tx, pay_date, -total, 'BG BETALNING ' || arrival, pay_je, id FROM sinv WHERE pay_date IS NOT NULL;
INSERT INTO je (id, fy, entry_date, descr, source_type, source_id, kind, created_at, bank_ctx)
SELECT pay_je, extract(year FROM pay_date)::int, pay_date, 'Betalning leverantörsfaktura ' || arrival,
       'supplier_invoice_paid', id, 'sinvpay', pg_temp.ts(pay_date),
       jsonb_build_array(jsonb_build_object('transaction_id', pay_tx, 'cash_account_id', pg_temp.uid(:'co'::uuid || ':cash'),
         'settlement_account', '1930', 'date', pay_date, 'amount', -total, 'currency', 'SEK'))
FROM sinv WHERE pay_date IS NOT NULL;
INSERT INTO jl (je_id, account, debit, ord) SELECT pay_je, '2440', total, 0 FROM sinv WHERE pay_date IS NOT NULL;
INSERT INTO jl (je_id, account, credit, ord) SELECT pay_je, '1930', total, 1 FROM sinv WHERE pay_date IS NOT NULL;

-- ---------- bank lines booked straight from the bank ----------
CREATE TEMP TABLE bank AS
SELECT y.fy, g AS n, pg_temp.uid(:'co'::uuid || ':bank-je:' || y.fy || ':' || g) AS je_id,
       pg_temp.uid(:'co'::uuid || ':bank-tx:' || y.fy || ':' || g) AS tx_id, random() AS r_kind, random() AS r_acc
FROM years y CROSS JOIN LATERAL generate_series(1, y.n_bank) g;
ALTER TABLE bank ADD COLUMN d date, ADD COLUMN kind text, ADD COLUMN net numeric, ADD COLUMN vat numeric,
  ADD COLUMN gross numeric, ADD COLUMN account text, ADD COLUMN merchant text, ADD COLUMN dims jsonb;
UPDATE bank SET d = pg_temp.fy_date(fy),
  kind = CASE WHEN r_kind < 0.60 THEN 'card' WHEN r_kind < 0.85 THEN 'fee' ELSE 'swish' END,
  account = (ARRAY['5460','5611','5800','6071','6110','6212','6230','6540','4010'])[1 + floor(r_acc * 9)::int],
  dims = pg_temp.dims();
UPDATE bank SET net = pg_temp.amt(40, 8000) WHERE kind = 'card';
UPDATE bank SET net = pg_temp.amt(10, 600) WHERE kind = 'fee';
UPDATE bank SET net = pg_temp.amt(100, 5000) WHERE kind = 'swish';
UPDATE bank SET vat = CASE WHEN kind = 'fee' THEN 0 ELSE round(net * 0.25, 2) END;
UPDATE bank SET gross = net + vat,
  merchant = CASE kind WHEN 'card' THEN 'Butik ' || (1 + floor(r_acc * 300))::int WHEN 'fee' THEN 'Testbanken'
                       ELSE 'Swish ' || (1 + floor(r_acc * 900))::int END;

INSERT INTO tx (id, tx_date, amount, descr, je_id, merchant)
SELECT tx_id, d, CASE WHEN kind = 'swish' THEN gross ELSE -gross END,
       CASE kind WHEN 'card' THEN 'KORTKÖP ' || merchant WHEN 'fee' THEN 'AVGIFT' ELSE 'SWISH ' || merchant END,
       je_id, merchant
FROM bank;
INSERT INTO je (id, fy, entry_date, descr, source_type, source_id, kind, created_at, bank_ctx)
SELECT b.je_id, b.fy, b.d, t.descr, 'bank_transaction', b.tx_id, 'bank', pg_temp.ts(b.d),
       jsonb_build_array(jsonb_build_object('transaction_id', b.tx_id, 'cash_account_id', pg_temp.uid(:'co'::uuid || ':cash'),
         'settlement_account', '1930', 'date', b.d, 'amount', t.amount, 'currency', 'SEK'))
FROM bank b JOIN tx t ON t.id = b.tx_id;
INSERT INTO jl (je_id, account, debit, ord, dims) SELECT je_id, account, net, 0, dims FROM bank WHERE kind = 'card';
INSERT INTO jl (je_id, account, debit, ord) SELECT je_id, '2641', vat, 1 FROM bank WHERE kind = 'card';
INSERT INTO jl (je_id, account, credit, ord) SELECT je_id, '1930', gross, 2 FROM bank WHERE kind = 'card';
INSERT INTO jl (je_id, account, debit, ord) SELECT je_id, '6570', net, 0 FROM bank WHERE kind = 'fee';
INSERT INTO jl (je_id, account, credit, ord) SELECT je_id, '1930', gross, 1 FROM bank WHERE kind = 'fee';
INSERT INTO jl (je_id, account, debit, ord) SELECT je_id, '1930', gross, 0 FROM bank WHERE kind = 'swish';
INSERT INTO jl (je_id, account, credit, ord, dims) SELECT je_id, '3001', net, 1, dims FROM bank WHERE kind = 'swish';
INSERT INTO jl (je_id, account, credit, ord) SELECT je_id, '2611', vat, 2 FROM bank WHERE kind = 'swish';

-- Unbooked bank lines, the Att göra queue: 400 in September and October of
-- the open year, a quarter of them deposits.
INSERT INTO tx (id, tx_date, amount, descr, merchant)
SELECT pg_temp.uid(:'co'::uuid || ':open-tx:' || g), date '2026-09-01' + floor(random() * 52)::int,
       CASE WHEN random() < 0.25 THEN pg_temp.amt(500, 60000) ELSE -pg_temp.amt(40, 9000) END,
       'KORTKÖP Butik ' || g, 'Butik ' || g
FROM generate_series(1, 400) g;

-- ---------- payroll, paid the 25th (2026: January to September) ----------
CREATE TEMP TABLE sal AS
SELECT m, d, extract(year FROM d)::int AS fy, pg_temp.amt(560000, 640000) AS gross,
       pg_temp.uid(:'co'::uuid || ':sal-lon:' || m) AS je_lon, pg_temp.uid(:'co'::uuid || ':sal-avg:' || m) AS je_avg,
       pg_temp.uid(:'co'::uuid || ':sal-sem:' || m) AS je_sem
FROM (SELECT m, (date '2024-01-25' + ((m - 1) || ' months')::interval)::date AS d FROM generate_series(1, 33) m) s;
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at)
SELECT je_lon, fy, d, 'Lön ' || to_char(d, 'YYYY-MM'), 'salary_payment', 'salary', pg_temp.ts(d) FROM sal
UNION ALL SELECT je_avg, fy, d, 'Arbetsgivaravgifter ' || to_char(d, 'YYYY-MM'), 'salary_payment', 'salary', pg_temp.ts(d) FROM sal
UNION ALL SELECT je_sem, fy, d, 'Semesterlöneskuld ' || to_char(d, 'YYYY-MM'), 'salary_payment', 'salary', pg_temp.ts(d) FROM sal;
INSERT INTO jl (je_id, account, debit, credit, ord)
SELECT je_lon, '7210', gross, 0, 0 FROM sal
UNION ALL SELECT je_lon, '2710', 0, round(gross * 0.30, 2), 1 FROM sal
UNION ALL SELECT je_lon, '1930', 0, gross - round(gross * 0.30, 2), 2 FROM sal
UNION ALL SELECT je_avg, '7510', round(gross * 0.3142, 2), 0, 0 FROM sal
UNION ALL SELECT je_avg, '2731', 0, round(gross * 0.3142, 2), 1 FROM sal
UNION ALL SELECT je_sem, '7290', round(gross * 0.12, 2), 0, 0 FROM sal
UNION ALL SELECT je_sem, '2920', 0, round(gross * 0.12, 2), 1 FROM sal
UNION ALL SELECT je_sem, '7519', round(gross * 0.12 * 0.3142, 2), 0, 2 FROM sal
UNION ALL SELECT je_sem, '2940', 0, round(gross * 0.12 * 0.3142, 2), 3 FROM sal;

-- ---------- storno and rättelse chains ----------
CREATE TEMP TABLE chain AS
SELECT y.fy, g, pg_temp.uid(:'co'::uuid || ':chain-orig:' || y.fy || ':' || g) AS orig,
       pg_temp.uid(:'co'::uuid || ':chain-storno:' || y.fy || ':' || g) AS storno,
       pg_temp.uid(:'co'::uuid || ':chain-corr:' || y.fy || ':' || g) AS corr, pg_temp.amt(200, 20000) AS amount
FROM years y CROSS JOIN LATERAL generate_series(1, y.n_chain) g;
ALTER TABLE chain ADD COLUMN d date;
UPDATE chain SET d = make_date(fy, 1, 1) + floor(random() * (CASE WHEN fy = 2026 THEN 280 ELSE 350 END))::int;
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at)
SELECT orig, fy, d, 'Kontorsmaterial ' || g, 'manual', 'orig', pg_temp.ts(d) FROM chain;
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at, reverses_id)
SELECT storno, fy, d + 3, 'Storno: Kontorsmaterial ' || g, 'storno', 'storno', pg_temp.ts(d + 3), orig FROM chain;
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at, correction_of_id)
SELECT corr, fy, d + 3, 'Rättelse: Kontorsmaterial ' || g, 'correction', 'corr', pg_temp.ts(d + 3), orig FROM chain;
INSERT INTO jl (je_id, account, debit, credit, ord)
SELECT orig, '6110', amount, 0, 0 FROM chain UNION ALL SELECT orig, '1930', 0, amount, 1 FROM chain
UNION ALL SELECT storno, '6110', 0, amount, 0 FROM chain UNION ALL SELECT storno, '1930', amount, 0, 1 FROM chain
UNION ALL SELECT corr, '6110', round(amount * 0.9, 2), 0, 0 FROM chain
UNION ALL SELECT corr, '1930', 0, round(amount * 0.9, 2), 1 FROM chain;

-- ---------- opening balance of the first year ----------
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at)
VALUES (pg_temp.uid(:'co'::uuid || ':ib:2024'), 2024, '2024-01-01', 'Ingående balans 2024', 'opening_balance', 'ib',
        '2024-01-15 09:00+01');
INSERT INTO jl (je_id, account, debit, credit, ord) VALUES
  (pg_temp.uid(:'co'::uuid || ':ib:2024'), '1930', 850000, 0, 0),
  (pg_temp.uid(:'co'::uuid || ':ib:2024'), '1220', 250000, 0, 1),
  (pg_temp.uid(:'co'::uuid || ':ib:2024'), '1229', 0, 75000, 2),
  (pg_temp.uid(:'co'::uuid || ':ib:2024'), '2081', 0, 50000, 3),
  (pg_temp.uid(:'co'::uuid || ':ib:2024'), '2091', 0, 975000, 4);

-- ---------- manual verifikat, filling each year to company_per_year ----------
-- Reserved per year: the omföring of last year's result (2025 and 2026), the
-- year-end pair in the closed years, and one VAT settlement per declared
-- month (12, 12, 9). The 2024 IB is in the plan already.
CREATE TEMP TABLE man AS
SELECT t.fy, g, pg_temp.uid(:'co'::uuid || ':man:' || t.fy || ':' || g) AS je_id, random() AS r_kind,
       random() AS r_acc, 1 + floor(random() * 3)::int AS n_debit, pg_temp.amt(100, 50000) AS amount
FROM (SELECT y.fy, :company_per_year - (SELECT count(*) FROM je WHERE je.fy = y.fy)
             - CASE y.fy WHEN 2024 THEN 2 + 12 WHEN 2025 THEN 1 + 2 + 12 ELSE 1 + 9 END AS cnt
      FROM years y) t
CROSS JOIN LATERAL generate_series(1, greatest(t.cnt, 0)::int) g;
ALTER TABLE man ADD COLUMN d date, ADD COLUMN cr text, ADD COLUMN descr text;
UPDATE man SET d = pg_temp.fy_date(fy);
UPDATE man SET (cr, descr) = (
  SELECT x.cr, x.descr FROM (VALUES
    (0, '1930', 'Utlägg'), (1, '2440', 'Leverantörsskuld'), (2, '1790', 'Upplösning förutbetald'),
    (3, '2990', 'Upplupen kostnad'), (4, '1930', 'Bankbetalning'), (5, '2893', 'Utlägg ägare'),
    (6, '1229', 'Avskrivning')
  ) x(k, cr, descr) WHERE x.k = floor(man.r_kind * 7)::int);
-- Debit lines: the long-tail accounts, skewed so a few carry most lines.
CREATE TEMP TABLE man_line AS
SELECT x.je_id, x.ord, a.account_number AS account, x.amount
FROM (
  SELECT m.je_id, k AS ord, 1 + floor(power(random(), 2.2) * (SELECT count(*) FROM bench_tail_account))::int AS acc_k,
         round(m.amount / m.n_debit, 2) AS amount
  FROM man m CROSS JOIN LATERAL generate_series(1, m.n_debit) k
) x JOIN bench_tail_account a ON a.k = x.acc_k;
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at)
SELECT je_id, fy, d, descr || ' ' || g, 'manual', 'manual', pg_temp.ts(d) FROM man;
INSERT INTO jl (je_id, account, debit, ord, dims)
SELECT ml.je_id, ml.account, ml.amount, ml.ord, CASE WHEN ml.account >= '3000' THEN pg_temp.dims() ELSE '{}' END
FROM man_line ml;
INSERT INTO jl (je_id, account, credit, ord)
SELECT m.je_id, m.cr, s.total, 0
FROM man m JOIN (SELECT je_id, sum(amount) AS total FROM man_line GROUP BY je_id) s ON s.je_id = m.je_id;

-- ---------- monthly VAT settlement, on the last day of each month ----------
CREATE TEMP TABLE vatm AS
SELECT date_trunc('month', j.entry_date)::date AS m, l.account, sum(l.credit - l.debit) AS bal
FROM jl l JOIN je j ON j.id = l.je_id
WHERE l.account IN ('2611', '2621', '2631', '2641') AND j.entry_date < '2026-10-01'
GROUP BY 1, 2;
CREATE TEMP TABLE vats AS
SELECT m, pg_temp.uid(:'co'::uuid || ':vat:' || m) AS je_id, (m + interval '1 month - 1 day')::date AS d
FROM (SELECT DISTINCT m FROM vatm) s;
INSERT INTO je (id, fy, entry_date, descr, source_type, kind, created_at)
SELECT je_id, extract(year FROM d)::int, d, 'Momsredovisning ' || to_char(m, 'YYYY-MM'), 'vat_settlement', 'vat',
       pg_temp.ts(d)
FROM vats;
INSERT INTO jl (je_id, account, debit, credit, ord)
SELECT s.je_id, v.account, greatest(v.bal, 0), greatest(-v.bal, 0), 0 FROM vatm v JOIN vats s USING (m)
UNION ALL
SELECT s.je_id, '2650', greatest(-x.bal, 0), greatest(x.bal, 0), 9
FROM (SELECT m, sum(bal) AS bal FROM vatm GROUP BY m) x JOIN vats s USING (m);

-- The originals of the storno chains end up reversed by their storno.
UPDATE je SET reversed_by = s.id FROM je s WHERE s.reverses_id = je.id;

-- Persist the plan for the transactions below.
DROP TABLE IF EXISTS bench_je, bench_jl, bench_tx, bench_inv, bench_inv_item, bench_sinv, bench_sinv_item, bench_sal;
CREATE TEMP TABLE bench_je AS SELECT * FROM je;
CREATE TEMP TABLE bench_jl AS SELECT * FROM jl;
CREATE TEMP TABLE bench_tx AS SELECT * FROM tx;
CREATE TEMP TABLE bench_inv AS SELECT * FROM inv;
CREATE TEMP TABLE bench_inv_item AS SELECT * FROM inv_item;
CREATE TEMP TABLE bench_sinv AS SELECT * FROM sinv;
CREATE TEMP TABLE bench_sinv_item AS SELECT * FROM sinv_item;
CREATE TEMP TABLE bench_sal AS SELECT * FROM sal;
DROP TABLE je, jl, tx, inv, inv_item, sinv, sinv_item, bank, sal, chain, man, man_line, vatm, vats, years;
CREATE INDEX ON bench_jl (je_id);
ANALYZE bench_je, bench_jl;
COMMIT;

-- ========================================================================
-- Writing the plan, one fiscal year at a time
-- ========================================================================
-- The rows go in in their final state with triggers off
-- (session_replication_role = replica), not through drafts and an UPDATE:
-- the per-row triggers cost about 2 ms per verifikat, and
-- guard_bank_booking_context's validate_journal_bank_anchors() re-reads all
-- of the company's bank lines for each verifikat posted (an index scan on
-- company_id filtered by an OR), which makes a bulk post of 50 000 quadratic.
-- What the triggers would have derived is written here instead: the commit
-- stamps, invoices.remaining_amount and the audit_log rows behandlingshistorik
-- reads, dated when the verifikat was made rather than when the seed ran.
-- seed.sql builds the ledger summaries afterwards and checks every verifikat
-- balances. The benchmark's own postings go through commit_journal_entry with
-- every trigger on.
SET session_replication_role = replica;

BEGIN;
INSERT INTO transactions (id, user_id, company_id, date, description, amount, currency, cash_account_id,
  category, is_business, merchant_name, import_source, transaction_method, created_at, updated_at, external_id,
  journal_entry_id, invoice_id, supplier_invoice_id, reconciliation_method, link_basis)
SELECT t.id, :'uid'::uuid, :'co'::uuid, t.tx_date, t.descr, t.amount, 'SEK', pg_temp.uid(:'co'::uuid || ':cash'),
  CASE WHEN t.je_id IS NULL THEN 'uncategorized' WHEN t.amount > 0 THEN 'income_services' ELSE 'expense_office' END,
  CASE WHEN t.je_id IS NULL THEN NULL ELSE true END,
  t.merchant, 'bank_file',
  CASE WHEN t.descr LIKE 'KORTKÖP%' THEN 'card' WHEN t.descr LIKE 'SWISH%' THEN 'swish' ELSE 'bankgiro' END,
  (t.tx_date + time '06:00')::timestamptz, (t.tx_date + time '06:00')::timestamptz, 'bench-' || t.id,
  t.je_id, t.invoice_id, t.supplier_invoice_id,
  CASE WHEN t.je_id IS NULL THEN NULL
       WHEN t.invoice_id IS NOT NULL OR t.supplier_invoice_id IS NOT NULL THEN 'auto_reference' ELSE 'manual' END,
  CASE WHEN t.je_id IS NULL THEN NULL
       WHEN t.invoice_id IS NOT NULL OR t.supplier_invoice_id IS NOT NULL THEN 'rule_ocr_reference' ELSE 'user_confirmed' END
FROM bench_tx t;
COMMIT;

-- Every verifikat of a year with its final voucher number and status, and its lines.
CREATE OR REPLACE FUNCTION pg_temp.post_year(p_co uuid, p_uid uuid, p_fy int) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
    entry_date, description, source_type, source_id, status, created_at, updated_at, committed_at,
    bank_booking_context, reverses_id, correction_of_id, reversed_by_id, commit_method, created_via,
    committed_actor_type, committed_by, committed_auth_role, committed_auth_uid)
  SELECT j.id, p_uid, p_co, pg_temp.fp(p_co, p_fy),
    row_number() OVER (ORDER BY (j.kind <> 'ib'), j.entry_date, j.created_at, j.id), 'A',
    j.entry_date, j.descr, j.source_type, j.source_id,
    CASE WHEN j.reversed_by IS NULL THEN 'posted' ELSE 'reversed' END,
    j.created_at, j.created_at + interval '2 minutes', j.created_at + interval '2 minutes',
    coalesce(j.bank_ctx, '[]'::jsonb), j.reverses_id, j.correction_of_id, j.reversed_by, 'user_accept',
    CASE WHEN j.source_type IN ('invoice_created', 'invoice_paid', 'supplier_invoice_paid', 'salary_payment',
                                'vat_settlement', 'opening_balance', 'result_appropriation') THEN 'system' ELSE 'manual' END,
    'user', p_uid, 'authenticated', p_uid
  FROM bench_je j WHERE j.fy = p_fy;
  INSERT INTO journal_entry_lines (id, journal_entry_id, account_number, debit_amount, credit_amount, currency,
    sort_order, dimensions, line_description, created_at)
  SELECT pg_temp.uid(l.je_id || ':' || l.ord || ':' || l.account), l.je_id, l.account, coalesce(l.debit, 0),
         coalesce(l.credit, 0), 'SEK', l.ord, coalesce(l.dims, '{}'::jsonb), l.descr, j.created_at
  FROM bench_jl l JOIN bench_je j ON j.id = l.je_id WHERE j.fy = p_fy;
END;
$$;

-- Year end of a closed year: bolagsskatt, then the resultatavslut onto 2099,
-- then next year's omföring 2099 -> 2098 (next year has no IB verifikat).
CREATE OR REPLACE FUNCTION pg_temp.close_year(p_co uuid, p_uid uuid, p_fy int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_fp uuid := pg_temp.fp(p_co, p_fy);
  v_last int;
  v_tax uuid := pg_temp.uid(p_co || ':year-end-tax:' || p_fy);
  v_close uuid := pg_temp.uid(p_co || ':year-end-close:' || p_fy);
  v_approp uuid := pg_temp.uid(p_co || ':approp:' || (p_fy + 1));
  v_result numeric;
BEGIN
  SELECT max(voucher_number) INTO v_last FROM journal_entries WHERE company_id = p_co AND fiscal_period_id = v_fp;

  CREATE TEMP TABLE pl ON COMMIT DROP AS
  SELECT l.account_number, sum(l.debit_amount - l.credit_amount) AS bal
  FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
  WHERE e.company_id = p_co AND e.fiscal_period_id = v_fp AND e.status IN ('posted', 'reversed')
    AND l.account_number >= '3000' AND l.account_number < '9000'
  GROUP BY 1;

  INSERT INTO journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
    description, source_type, status, created_at, updated_at, committed_at, commit_method, created_via,
    committed_actor_type, committed_by, committed_auth_role, committed_auth_uid)
  VALUES (v_tax, p_uid, p_co, v_fp, v_last + 1, 'A', make_date(p_fy, 12, 31),
          'Bokslutsdisposition: Bolagsskatt ' || p_fy, 'year_end', 'posted',
          make_timestamptz(p_fy + 1, 3, 10, 10, 0, 0, 'Europe/Stockholm'),
          make_timestamptz(p_fy + 1, 3, 10, 10, 1, 0, 'Europe/Stockholm'),
          make_timestamptz(p_fy + 1, 3, 10, 10, 1, 0, 'Europe/Stockholm'), 'user_accept', 'system',
          'user', p_uid, 'authenticated', p_uid);
  INSERT INTO journal_entry_lines (id, journal_entry_id, account_number, debit_amount, credit_amount, sort_order,
    created_at)
  SELECT pg_temp.uid(v_tax || ':8910'), v_tax, '8910', round(greatest(-sum(bal), 1000) * 0.206, 2), 0, 0,
         make_timestamptz(p_fy + 1, 3, 10, 10, 0, 0, 'Europe/Stockholm') FROM pl
  UNION ALL SELECT pg_temp.uid(v_tax || ':2512'), v_tax, '2512', 0, round(greatest(-sum(bal), 1000) * 0.206, 2), 1,
         make_timestamptz(p_fy + 1, 3, 10, 10, 0, 0, 'Europe/Stockholm') FROM pl;
  INSERT INTO pl SELECT '8910', round(greatest(-sum(bal), 1000) * 0.206, 2) FROM pl;

  INSERT INTO journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
    description, source_type, status, created_at, updated_at, committed_at, commit_method, created_via,
    committed_actor_type, committed_by, committed_auth_role, committed_auth_uid)
  VALUES (v_close, p_uid, p_co, v_fp, v_last + 2, 'A', make_date(p_fy, 12, 31),
          'Bokslut ' || p_fy || ': årets resultat', 'year_end', 'posted',
          make_timestamptz(p_fy + 1, 3, 10, 10, 5, 0, 'Europe/Stockholm'),
          make_timestamptz(p_fy + 1, 3, 10, 10, 6, 0, 'Europe/Stockholm'),
          make_timestamptz(p_fy + 1, 3, 10, 10, 6, 0, 'Europe/Stockholm'), 'user_accept', 'system',
          'user', p_uid, 'authenticated', p_uid);
  INSERT INTO journal_entry_lines (id, journal_entry_id, account_number, debit_amount, credit_amount, sort_order,
    line_description, created_at)
  SELECT pg_temp.uid(v_close || ':' || account_number), v_close, account_number, greatest(-b, 0), greatest(b, 0),
         row_number() OVER (ORDER BY account_number), 'Closing: ' || account_number,
         make_timestamptz(p_fy + 1, 3, 10, 10, 5, 0, 'Europe/Stockholm')
  FROM (SELECT account_number, sum(bal) AS b FROM pl GROUP BY 1) s WHERE abs(b) >= 0.005
  UNION ALL
  SELECT pg_temp.uid(v_close || ':2099'), v_close, '2099', greatest(sum(bal), 0), greatest(-sum(bal), 0), 999,
         'Årets resultat', make_timestamptz(p_fy + 1, 3, 10, 10, 5, 0, 'Europe/Stockholm') FROM pl;

  -- The year's result as it stands on 2099 after the closing, carried to 2098.
  SELECT sum(l.credit_amount - l.debit_amount) INTO v_result
  FROM journal_entry_lines l WHERE l.journal_entry_id = v_close AND l.account_number = '2099';
  INSERT INTO bench_je (id, fy, entry_date, descr, source_type, kind, created_at)
  VALUES (v_approp, p_fy + 1, make_date(p_fy + 1, 5, 20), 'Omföring av föregående års resultat',
          'result_appropriation', 'approp', make_timestamptz(p_fy + 1, 5, 20, 14, 0, 0, 'Europe/Stockholm'));
  INSERT INTO bench_jl (je_id, account, debit, credit, ord)
  VALUES (v_approp, '2099', greatest(v_result, 0), greatest(-v_result, 0), 0),
         (v_approp, '2098', greatest(-v_result, 0), greatest(v_result, 0), 1);
END;
$$;

BEGIN;
SELECT pg_temp.post_year(:'co'::uuid, :'uid'::uuid, 2024) AS done \gset
SELECT pg_temp.close_year(:'co'::uuid, :'uid'::uuid, 2024) AS done \gset
COMMIT;
BEGIN;
SELECT pg_temp.post_year(:'co'::uuid, :'uid'::uuid, 2025) AS done \gset
SELECT pg_temp.close_year(:'co'::uuid, :'uid'::uuid, 2025) AS done \gset
COMMIT;
BEGIN;
SELECT pg_temp.post_year(:'co'::uuid, :'uid'::uuid, 2026) AS done \gset
COMMIT;

-- ---------- customer invoices ----------
BEGIN;
INSERT INTO invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status,
  currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate,
  paid_at, paid_amount, remaining_amount, journal_entry_id, created_at, updated_at, delivery_date)
SELECT i.id, :'uid'::uuid, :'co'::uuid, pg_temp.uid(:'co'::uuid || ':cust:' || i.customer_n), i.invoice_number,
  i.invoice_date, i.invoice_date + 30,
  CASE WHEN i.pay_date IS NOT NULL THEN 'paid' WHEN i.invoice_date + 30 < :'today'::date THEN 'overdue' ELSE 'sent' END,
  'SEK', i.subtotal, i.subtotal, i.vat, i.vat, i.total, i.total,
  CASE i.vat_pct WHEN 25 THEN 'standard_25' WHEN 12 THEN 'reduced_12' WHEN 6 THEN 'reduced_6' ELSE 'export' END,
  i.vat_pct, CASE WHEN i.pay_date IS NOT NULL THEN (i.pay_date + time '12:00')::timestamptz END,
  CASE WHEN i.pay_date IS NOT NULL THEN i.total ELSE 0 END, CASE WHEN i.pay_date IS NOT NULL THEN 0 ELSE i.total END,
  i.je_id, (i.invoice_date + time '08:00')::timestamptz, (i.invoice_date + time '08:00')::timestamptz, i.invoice_date
FROM bench_inv i;
INSERT INTO invoice_items (invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate,
  vat_amount, revenue_account, dimensions)
SELECT it.invoice_id, it.ord, 'Tjänst ' || it.ord, 1, 'st', it.net, it.net, it.vat_pct,
  round(it.net * it.vat_pct / 100.0, 2), it.account, it.dims
FROM bench_inv_item it;
INSERT INTO invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id,
  transaction_id, source, created_at, updated_at)
SELECT :'uid'::uuid, :'co'::uuid, i.id, i.pay_date, i.total, 'SEK', i.pay_je, i.pay_tx, 'bank',
  (i.pay_date + time '12:00')::timestamptz, (i.pay_date + time '12:00')::timestamptz
FROM bench_inv i WHERE i.pay_date IS NOT NULL;
COMMIT;

-- ---------- supplier invoices and their documents ----------
BEGIN;
INSERT INTO document_attachments (id, user_id, company_id, storage_path, file_name, file_size_bytes, mime_type,
  sha256_hash, upload_source, journal_entry_id, created_at, updated_at, doc_type, page_count)
SELECT s.doc_id, :'uid'::uuid, :'co'::uuid, :'co'::uuid || '/supplier-invoices/' || s.id || '.pdf',
  'faktura-' || s.arrival || '.pdf', 84000, 'application/pdf', encode(sha256(s.id::text::bytea), 'hex'), 'email',
  s.je_id, (s.invoice_date + time '09:00')::timestamptz, (s.invoice_date + time '09:00')::timestamptz,
  'supplier_invoice', 1
FROM bench_sinv s;
INSERT INTO supplier_invoices (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
  invoice_date, due_date, received_date, status, currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total,
  total_sek, vat_treatment, paid_at, paid_amount, remaining_amount, registration_journal_entry_id,
  payment_journal_entry_id, transaction_id, document_id, created_at, updated_at, approved_at, payment_reference)
SELECT s.id, :'uid'::uuid, :'co'::uuid, pg_temp.uid(:'co'::uuid || ':supp:' || s.supplier_n), s.arrival,
  'LF-' || s.fy || '-' || s.n, s.invoice_date, s.invoice_date + 30, s.invoice_date + 1,
  CASE WHEN s.pay_date IS NOT NULL THEN 'paid' WHEN s.invoice_date > :'today'::date - 14 THEN 'registered'
       ELSE 'approved' END,
  'SEK', s.subtotal, s.subtotal, s.vat, s.vat, s.total, s.total,
  CASE WHEN s.has_vat THEN 'standard_25' ELSE 'exempt' END,
  CASE WHEN s.pay_date IS NOT NULL THEN (s.pay_date + time '12:00')::timestamptz END,
  CASE WHEN s.pay_date IS NOT NULL THEN s.total ELSE 0 END,
  CASE WHEN s.pay_date IS NOT NULL THEN 0 ELSE s.total END,
  s.je_id, CASE WHEN s.pay_date IS NOT NULL THEN s.pay_je END, CASE WHEN s.pay_date IS NOT NULL THEN s.pay_tx END,
  s.doc_id, (s.invoice_date + time '09:00')::timestamptz,
  coalesce((s.pay_date + time '12:00')::timestamptz, (s.invoice_date + time '09:00')::timestamptz),
  CASE WHEN s.invoice_date <= :'today'::date - 14 THEN (s.invoice_date + time '15:00')::timestamptz END,
  (1000000 + s.arrival)::text
FROM bench_sinv s;
INSERT INTO supplier_invoice_items (supplier_invoice_id, sort_order, description, quantity, unit, unit_price,
  line_total, account_number, vat_rate, vat_amount, dimensions)
SELECT it.sinv_id, it.ord, 'Inköp ' || it.ord, 1, 'st', it.net, it.net, it.account,
  CASE WHEN s.has_vat THEN 0.25 ELSE 0 END, CASE WHEN s.has_vat THEN round(it.net * 0.25, 2) ELSE 0 END, it.dims
FROM bench_sinv_item it JOIN bench_sinv s ON s.id = it.sinv_id;
INSERT INTO supplier_invoice_payments (user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
  journal_entry_id, transaction_id, created_at)
SELECT :'uid'::uuid, :'co'::uuid, s.id, s.pay_date, s.total, 'SEK', s.pay_je, s.pay_tx,
  (s.pay_date + time '12:00')::timestamptz
FROM bench_sinv s WHERE s.pay_date IS NOT NULL;
COMMIT;

-- ---------- receipts: 92 % of the bank verifikat, 60 % of the manual ones ----------
BEGIN;
SELECT setseed(:rnd_seed / 3) AS seeded \gset
INSERT INTO document_attachments (id, user_id, company_id, storage_path, file_name, file_size_bytes, mime_type,
  sha256_hash, upload_source, journal_entry_id, created_at, updated_at, doc_type, page_count)
SELECT pg_temp.uid(:'co'::uuid || ':receipt:' || j.id), :'uid'::uuid, :'co'::uuid,
  :'co'::uuid || '/receipts/' || j.id || '.jpg', 'kvitto-' || left(j.id::text, 8) || '.jpg', 320000, 'image/jpeg',
  encode(sha256(j.id::text::bytea), 'hex'), CASE WHEN random() < 0.5 THEN 'camera' ELSE 'email' END, j.id,
  j.created_at + interval '1 hour', j.created_at + interval '1 hour', 'receipt', 1
FROM (SELECT * FROM bench_je ORDER BY id) j
WHERE (j.kind = 'bank' AND random() < 0.92) OR (j.kind = 'manual' AND random() < 0.60);
COMMIT;

-- ---------- payroll: 15 employees, booked monthly runs linked to the salary verifikat ----------
BEGIN;
INSERT INTO employees (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
  employment_start, employment_type, personnel_category, salary_type, monthly_salary, vacation_rule,
  vacation_days_per_year, workdays_per_week, tax_column, employment_degree)
SELECT pg_temp.uid(:'co'::uuid || ':emp:' || g), :'co'::uuid, :'uid'::uuid, 'Anställd', 'Nummer ' || g,
  encode(sha256(('pnr' || g)::bytea), 'hex') || encode(sha256(('pnr2' || g)::bytea), 'hex'),
  lpad((1000 + g)::text, 4, '0'), '2023-09-01', 'employee', 'tjansteman', 'monthly', 34000 + g * 1200,
  'sammaloneregeln', 25, 5, 1, 100
FROM generate_series(1, 15) g;
INSERT INTO salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status, voucher_series,
  salary_entry_id, avgifter_entry_id, vacation_entry_id, booked_at, booked_by, approved_at, approved_by, paid_at,
  created_at)
SELECT pg_temp.uid(:'co'::uuid || ':run:' || s.m), :'co'::uuid, :'uid'::uuid, extract(year FROM s.d)::int,
  extract(month FROM s.d)::int, s.d, 'booked', 'A', s.je_lon, s.je_avg, s.je_sem,
  (s.d + time '10:00')::timestamptz, :'uid'::uuid, (s.d - 3 + time '10:00')::timestamptz, :'uid'::uuid,
  (s.d + time '09:00')::timestamptz, (s.d - 5 + time '10:00')::timestamptz
FROM bench_sal s;
INSERT INTO salary_run_employees (salary_run_id, employee_id, company_id, employment_degree, monthly_salary,
  salary_type, gross_salary, taxable_income, tax_withheld, net_salary, avgifter_rate, avgifter_amount, avgifter_basis,
  vacation_accrual, vacation_accrual_avgifter, tax_table_number, tax_column, tax_table_year, personnel_category)
SELECT pg_temp.uid(:'co'::uuid || ':run:' || s.m), e.id, :'co'::uuid, 100, e.monthly_salary, 'monthly',
  e.monthly_salary, e.monthly_salary, round(e.monthly_salary * 0.30, 2),
  e.monthly_salary - round(e.monthly_salary * 0.30, 2), 0.3142, round(e.monthly_salary * 0.3142, 2), e.monthly_salary,
  round(e.monthly_salary * 0.12, 2), round(e.monthly_salary * 0.12 * 0.3142, 2), 33, 1, extract(year FROM s.d)::int,
  'tjansteman'
FROM bench_sal s CROSS JOIN employees e WHERE e.company_id = :'co'::uuid;
UPDATE salary_runs r SET total_gross = x.g, total_tax = x.t, total_net = x.n, total_avgifter = x.a,
  total_vacation_accrual = x.v, total_employer_cost = x.g + x.a
FROM (SELECT salary_run_id, sum(gross_salary) g, sum(tax_withheld) t, sum(net_salary) n, sum(avgifter_amount) a,
             sum(vacation_accrual) v FROM salary_run_employees WHERE company_id = :'co'::uuid GROUP BY 1) x
WHERE x.salary_run_id = r.id;
COMMIT;

-- ---------- periods: 2024 and 2025 closed and locked with their closing entries ----------
BEGIN;
UPDATE fiscal_periods f SET closing_entry_id = pg_temp.uid(:'co'::uuid || ':year-end-close:' || f.name),
  is_closed = true, closed_at = make_timestamptz(f.name::int + 1, 3, 10, 10, 20, 0, 'Europe/Stockholm'),
  locked_at = make_timestamptz(f.name::int + 1, 3, 10, 10, 20, 0, 'Europe/Stockholm')
WHERE f.company_id = :'co'::uuid AND f.name IN ('2024', '2025');
INSERT INTO voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
SELECT :'uid'::uuid, :'co'::uuid, fiscal_period_id, 'A', max(voucher_number) FROM journal_entries
WHERE company_id = :'co'::uuid
GROUP BY fiscal_period_id;
UPDATE company_settings SET bookkeeping_locked_through = '2025-12-31' WHERE company_id = :'co'::uuid;
COMMIT;

-- ---------- the audit_log rows the audit triggers write on these paths ----------
-- (write_sie_header_audit, write_audit_log): a verifikat's INSERT as a draft
-- and its COMMIT, the REVERSE of a stornerad one, each document's INSERT, a
-- supplier invoice's INSERT and its approval and payment updates, and each
-- period lock. Line rows are left out: the trigger writes them with no
-- company_id, so no company-scoped read meets them.
BEGIN;
INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
  description, actor_type, created_at)
SELECT e.user_id, e.company_id, 'INSERT', 'journal_entries', e.id, e.user_id, NULL,
       to_jsonb(e) || jsonb_build_object('status', 'draft', 'voucher_number', 0, 'committed_at', NULL,
                                         'reversed_by_id', NULL),
       'Created journal_entries record', 'user', e.created_at
FROM journal_entries e WHERE e.company_id = :'co'::uuid
UNION ALL
SELECT e.user_id, e.company_id, 'COMMIT', 'journal_entries', e.id, e.user_id,
       to_jsonb(e) || jsonb_build_object('status', 'draft', 'voucher_number', 0, 'committed_at', NULL,
                                         'reversed_by_id', NULL),
       to_jsonb(e) || jsonb_build_object('status', 'posted', 'reversed_by_id', NULL),
       'Committed journal entry ' || e.voucher_series || e.voucher_number, 'user', e.committed_at
FROM journal_entries e WHERE e.company_id = :'co'::uuid
UNION ALL
SELECT e.user_id, e.company_id, 'REVERSE', 'journal_entries', e.id, e.user_id,
       to_jsonb(e) || jsonb_build_object('status', 'posted', 'reversed_by_id', NULL), to_jsonb(e),
       'Reversed journal entry ' || e.voucher_series || e.voucher_number, 'user', s.committed_at
FROM journal_entries e JOIN journal_entries s ON s.id = e.reversed_by_id
WHERE e.company_id = :'co'::uuid AND e.status = 'reversed'
UNION ALL
SELECT d.user_id, d.company_id, 'INSERT', 'document_attachments', d.id, d.user_id, NULL, to_jsonb(d),
       'Created document_attachments record', 'user', d.created_at
FROM document_attachments d WHERE d.company_id = :'co'::uuid
UNION ALL
SELECT s.user_id, s.company_id, 'INSERT', 'supplier_invoices', s.id, s.user_id, NULL,
       to_jsonb(s) || jsonb_build_object('status', 'registered', 'approved_at', NULL, 'paid_at', NULL),
       'Created supplier_invoices record', 'user', s.created_at
FROM supplier_invoices s WHERE s.company_id = :'co'::uuid
UNION ALL
SELECT s.user_id, s.company_id, 'UPDATE', 'supplier_invoices', s.id, s.user_id,
       to_jsonb(s) || jsonb_build_object('status', 'registered', 'approved_at', NULL, 'paid_at', NULL),
       to_jsonb(s) || jsonb_build_object('status', 'approved', 'paid_at', NULL),
       'Updated supplier_invoices record', 'user', s.approved_at
FROM supplier_invoices s WHERE s.company_id = :'co'::uuid AND s.approved_at IS NOT NULL
UNION ALL
SELECT s.user_id, s.company_id, 'UPDATE', 'supplier_invoices', s.id, s.user_id,
       to_jsonb(s) || jsonb_build_object('status', 'approved', 'paid_at', NULL), to_jsonb(s),
       'Updated supplier_invoices record', 'user', s.paid_at
FROM supplier_invoices s WHERE s.company_id = :'co'::uuid AND s.paid_at IS NOT NULL
UNION ALL
SELECT f.user_id, f.company_id, 'LOCK_PERIOD', 'fiscal_periods', f.id, f.user_id,
       to_jsonb(f) || jsonb_build_object('is_closed', false, 'closed_at', NULL, 'locked_at', NULL), to_jsonb(f),
       'Locked fiscal period "' || f.name || '"', 'user', f.locked_at
FROM fiscal_periods f WHERE f.company_id = :'co'::uuid AND f.locked_at IS NOT NULL;
COMMIT;

SET session_replication_role = origin;

DROP TABLE bench_je, bench_jl, bench_tx, bench_inv, bench_inv_item, bench_sinv, bench_sinv_item, bench_sal,
  bench_tail_account;

SELECT f.name AS fiscal_year, count(DISTINCT e.id) AS verifikat, count(l.id) AS lines,
       round(100.0 * count(l.id) FILTER (WHERE l.dimensions <> '{}'::jsonb) / count(l.id), 1) AS tagged_pct,
       count(DISTINCT l.account_number) AS accounts
FROM journal_entries e JOIN fiscal_periods f ON f.id = e.fiscal_period_id
JOIN journal_entry_lines l ON l.journal_entry_id = e.id
WHERE e.company_id = :'co'::uuid
GROUP BY ROLLUP (f.name) ORDER BY f.name;
