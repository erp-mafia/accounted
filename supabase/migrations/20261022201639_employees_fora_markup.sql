-- Fora uppmärkning: the FOK code an arbetare is reported to Fora under.
--
-- Since 2024-01-01 employees covered by Avtalspension SAF-LO (usually
-- arbetare) are marked up at Fora with a FOK code (försäkringsomfattningskod,
-- one per kollektivavtal group, e.g. FOK306834 "Arbetare, Byggavtalet") and a
-- start date, and their cash gross pay is reported every month in a JSON file
-- (Fora's "Filspecifikation för uppmärkning av anställda och månatlig
-- lönerapportering", v1.37). The employer reads its valid codes on Fora's
-- Mina sidor.
--
-- Only the current code is stored. Fora ends the previous uppmärkning itself
-- the day before a new start date, and a file with an earlier start date
-- replaces what came after it, so the monthly file (lib/salary/fora) sends
-- this one code every month and Fora's state follows ours. No history table.
--
-- Both set or both null. Owners and board members are never marked up (Fora:
-- "Exempel på anställda som inte ska märkas upp: ... Ägare"), so a code is
-- only allowed on employment_type 'employee'. The application refuses all of
-- this first on every door (lib/salary/fora/markup.ts); these constraints are
-- the backstop.

alter table public.employees
  add column fora_fok_id text
    constraint employees_fora_fok_id_format_check
      check (fora_fok_id ~ '^FOK[0-9]{6}$'),
  add column fora_fok_start_date date;

alter table public.employees
  add constraint employees_fora_markup_complete_check
    check ((fora_fok_id is null) = (fora_fok_start_date is null)),
  add constraint employees_fora_markup_employee_only_check
    check (fora_fok_id is null or employment_type = 'employee');

comment on column public.employees.fora_fok_id is
  'Fora uppmärkning (FOK code, e.g. FOK306834) the employee is reported to Fora under every month. Null: not reported to Fora.';
comment on column public.employees.fora_fok_start_date is
  'The date the FOK code applies from (Fora markups[].startDate). Set together with fora_fok_id.';

notify pgrst, 'reload schema';
