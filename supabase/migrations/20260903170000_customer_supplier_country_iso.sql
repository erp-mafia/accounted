-- customers.country and suppliers.country are ISO 3166-1 alpha-2 (#2025, #2028).
--
-- The columns have always defaulted to 'SE' and every reader (periodisk
-- sammanställning / SKV 5740, Peppol BIS Billing, the provider importers)
-- treats the value as a code, but the customer form and the v1 API wrote
-- English names ("Sweden", "Germany"). This migration:
--
--   1. adds public.normalize_country_code(text): the SQL twin of
--      normalizeCountryCode() in lib/vat/country-codes.ts (same table);
--   2. keeps the pre-backfill text in a new country_raw column on both
--      tables for every row it touches, so the backfill is one UPDATE to undo;
--   3. maps every row whose country is not already an uppercase code through
--      the function. Names the table does not know are left exactly as they
--      were (and listed in country_raw); the periodisk report already warns
--      on those and the customer form asks for a pick before it saves.
--
-- Rollback (restores the original text on every touched row):
--   update public.customers set country = country_raw where country_raw is not null;
--   update public.suppliers set country = country_raw where country_raw is not null;
--
-- Rows still unmapped after the backfill:
--   select id, company_id, name, country from public.customers
--    where country is not null and country !~ '^[A-Z]{2}$';
--   (same for public.suppliers)

create or replace function public.normalize_country_code(input text)
returns text
language plpgsql
immutable
as $$
declare
  folded text;
  upper_input text;
begin
  folded := lower(regexp_replace(btrim(coalesce(input, '')), '\s+', ' ', 'g'));
  folded := regexp_replace(folded, '\.+$', '');
  if folded = '' then
    return null;
  end if;

  upper_input := upper(btrim(input));
  if upper_input ~ '^[A-Z]{2}$' then
    if upper_input = 'EL' then return 'GR'; end if;
    if upper_input = 'UK' then return 'GB'; end if;
    return upper_input;
  end if;

  return (
    select m.code
    from (values
      ('australia', 'AU'),
      ('australien', 'AU'),
      ('austria', 'AT'),
      ('belgien', 'BE'),
      ('belgium', 'BE'),
      ('brasilien', 'BR'),
      ('brazil', 'BR'),
      ('britain', 'GB'),
      ('bulgaria', 'BG'),
      ('bulgarien', 'BG'),
      ('canada', 'CA'),
      ('china', 'CN'),
      ('colombia', 'CO'),
      ('croatia', 'HR'),
      ('curaçao', 'CW'),
      ('cypern', 'CY'),
      ('cyprus', 'CY'),
      ('czech republic', 'CZ'),
      ('czechia', 'CZ'),
      ('danmark', 'DK'),
      ('denmark', 'DK'),
      ('deutschland', 'DE'),
      ('england', 'GB'),
      ('estland', 'EE'),
      ('estonia', 'EE'),
      ('finland', 'FI'),
      ('france', 'FR'),
      ('frankrike', 'FR'),
      ('förenade arabemiraten', 'AE'),
      ('germany', 'DE'),
      ('great britain', 'GB'),
      ('greece', 'GR'),
      ('grekland', 'GR'),
      ('holland', 'NL'),
      ('hong kong', 'HK'),
      ('hongkong', 'HK'),
      ('hungary', 'HU'),
      ('iceland', 'IS'),
      ('india', 'IN'),
      ('indien', 'IN'),
      ('ireland', 'IE'),
      ('irland', 'IE'),
      ('island', 'IS'),
      ('israel', 'IL'),
      ('italien', 'IT'),
      ('italy', 'IT'),
      ('japan', 'JP'),
      ('kanada', 'CA'),
      ('kina', 'CN'),
      ('kroatien', 'HR'),
      ('latvia', 'LV'),
      ('lettland', 'LV'),
      ('liechtenstein', 'LI'),
      ('litauen', 'LT'),
      ('lithuania', 'LT'),
      ('luxembourg', 'LU'),
      ('luxemburg', 'LU'),
      ('malta', 'MT'),
      ('mexico', 'MX'),
      ('mexiko', 'MX'),
      ('nederlanderna', 'NL'),
      ('nederländerna', 'NL'),
      ('netherlands', 'NL'),
      ('new zealand', 'NZ'),
      ('norge', 'NO'),
      ('norway', 'NO'),
      ('nya zeeland', 'NZ'),
      ('osterrike', 'AT'),
      ('poland', 'PL'),
      ('polen', 'PL'),
      ('portugal', 'PT'),
      ('republic of ireland', 'IE'),
      ('republic of korea', 'KR'),
      ('romania', 'RO'),
      ('rumänien', 'RO'),
      ('saint kitts & nevis', 'KN'),
      ('saint kitts and nevis', 'KN'),
      ('saint kitts och nevis', 'KN'),
      ('schweiz', 'CH'),
      ('serbia', 'RS'),
      ('serbien', 'RS'),
      ('singapore', 'SG'),
      ('slovakia', 'SK'),
      ('slovakien', 'SK'),
      ('slovenia', 'SI'),
      ('slovenien', 'SI'),
      ('south africa', 'ZA'),
      ('south korea', 'KR'),
      ('spain', 'ES'),
      ('spanien', 'ES'),
      ('st kitts & nevis', 'KN'),
      ('st kitts and nevis', 'KN'),
      ('st. kitts and nevis', 'KN'),
      ('storbritannien', 'GB'),
      ('suisse', 'CH'),
      ('sverige', 'SE'),
      ('sweden', 'SE'),
      ('switzerland', 'CH'),
      ('sydafrika', 'ZA'),
      ('sydkorea', 'KR'),
      ('thailand', 'TH'),
      ('the netherlands', 'NL'),
      ('tjeckien', 'CZ'),
      ('turkey', 'TR'),
      ('turkiet', 'TR'),
      ('turkiye', 'TR'),
      ('tyskland', 'DE'),
      ('türkiye', 'TR'),
      ('u.s.a', 'US'),
      ('uae', 'AE'),
      ('uk', 'GB'),
      ('ukraina', 'UA'),
      ('ukraine', 'UA'),
      ('ungern', 'HU'),
      ('united arab emirates', 'AE'),
      ('united kingdom', 'GB'),
      ('united kingdom of great britain and northern ireland', 'GB'),
      ('united states', 'US'),
      ('united states of america', 'US'),
      ('usa', 'US'),
      ('österrike', 'AT')
    ) as m(name, code)
    where m.name = folded
    limit 1
  );
end;
$$;

comment on function public.normalize_country_code(text) is
  'ISO 3166-1 alpha-2 from a code in any case, EL/UK, or a Swedish/English country name; null when unknown. Mirrors lib/vat/country-codes.ts.';

alter table public.customers add column if not exists country_raw text;
alter table public.suppliers add column if not exists country_raw text;

comment on column public.customers.country_raw is
  'The free-text country the row held before the 2026-09 ISO backfill, kept for rollback; null for rows the backfill did not touch.';
comment on column public.suppliers.country_raw is
  'The free-text country the row held before the 2026-09 ISO backfill, kept for rollback; null for rows the backfill did not touch.';

-- Backfill: every row that is not already an uppercase alpha-2 code. An
-- empty string is "no country" and becomes null (the periodisk report
-- already treats both the same); a null stays null, nothing is guessed.
update public.customers
   set country_raw = country,
       country = case when btrim(country) = '' then null else coalesce(public.normalize_country_code(country), country) end
 where country is not null
   and country !~ '^[A-Z]{2}$';

update public.suppliers
   set country_raw = country,
       country = case when btrim(country) = '' then null else coalesce(public.normalize_country_code(country), country) end
 where country is not null
   and country !~ '^[A-Z]{2}$';

NOTIFY pgrst, 'reload schema';
