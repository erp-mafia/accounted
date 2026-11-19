-- Replace the old seed descriptions of 6072, 7631 and 7632 in every kontoplan
-- that still holds them word for word (accounted#92).
--
-- The BAS reference texts in src/lib/bookkeeping/bas-data
-- (class-6-other-external.ts and class-7-personnel.ts) were corrected on
-- 2026-10-22. A chart row copies the description when the account
-- is added, so every chart seeded before kept the old text. Two of them are
-- wrong: 6072's says only the part above a deductible amount is
-- non-deductible, while a meal is not income-tax deductible at all since 2017
-- (IL 16 kap. 2 §), and 7631's calls a jullunch deductible. 7632's old text is
-- only its name; it takes the new one so the pair reads the same in every
-- chart. The kontoplan and the MCP list-accounts tool show these texts to
-- people and agents.
--
-- Left as they are:
--   * the charts of companies archived by a migration reset, which the
--     update skips (company_migration_resets);
--   * 6071: its old text is in no chart, so the account is not listed
--     below.
--
-- Only a description that still equals the old seed text exactly changes: a
-- text a person, an agent or an import wrote stays. The account name (a
-- renamed account keeps its name), number, VAT defaults and every posted line
-- stay as they are.
--
-- audit_chart_of_accounts writes one audit_log row per changed account, the
-- behandlingshistorik entry for this kontoplan change (BFNAR 2013:2 p. 9.16),
-- tagged actor_type 'system' with this migration as the label so it never
-- reads as the company's own change. Re-runnable: a changed row no longer
-- matches.

do $$
begin
  perform set_config('gnubok.actor_type', 'system', true);
  perform set_config(
    'gnubok.actor_label',
    'migration 20261023011000 representation_account_descriptions',
    true
  );

  update public.chart_of_accounts coa
     set description = seed.new_text
    from (values
      ('6072',
       'Representation som överstiger avdragsgilla beloppet. Inte skattemässigt avdragsgill.',
       'Representation som inte är avdragsgill vid inkomstbeskattningen: måltider (sedan 2017) och belopp över de avdragsgilla gränserna. Momsen kan ändå vara avdragsgill.'),
      ('7631',
       'Avdragsgill intern representation, t.ex. personalfester och jullunch.',
       'Intern representation som är avdragsgill vid inkomstbeskattningen: enklare förtäring (högst 60 kr per person exkl. moms) och kringkostnader vid personalfest (högst 180 kr per person exkl. moms). Måltider, som jullunch, bokas på 7632.'),
      ('7632',
       'Personalrepresentation, ej avdragsgill',
       'Intern representation som inte är avdragsgill vid inkomstbeskattningen: måltider (sedan 2017) och belopp över de avdragsgilla gränserna. Momsen kan ändå vara avdragsgill.')
    ) as seed(account_number, old_text, new_text)
   where coa.account_number = seed.account_number
     and coa.description = seed.old_text
     and not exists (
       select 1
         from public.company_migration_resets r
        where r.source_company_id = coa.company_id
     );
end $$;
