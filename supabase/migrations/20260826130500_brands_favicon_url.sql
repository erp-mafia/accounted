-- Brands: optional dedicated tab icon (WL follow-up, founder ask 2026-08-05).
--
-- The root layout uses brands.logo_url as rel="icon" on branded hosts, but
-- byra logos are wide lockups that squash badly at 16px. favicon_url holds a
-- square mark; the layout prefers it over logo_url for the tab icon and
-- falls back to logo_url when unset. Ops-managed like the rest of brands
-- (no write RLS; byra self-service edits only the logo via its API route).

alter table public.brands
  add column if not exists favicon_url text;

comment on column public.brands.favicon_url is
  'Square tab icon URL; preferred over logo_url for rel="icon" on branded hosts.';

notify pgrst, 'reload schema';
