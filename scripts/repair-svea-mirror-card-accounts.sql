-- One-shot repair: switch off Svea's mirror card accounts (issue #2565 follow-up, 2026-09-29).
--
-- Svea Bank lists a debit-card account next to the företagskonto
-- (BOKIO_Debit_Business / SVEA_MQ_Debit_B2B, no IBAN, no BBAN). It holds no
-- money: every card purchase arrives on the main account AND as an
-- opposite-sign twin on the card account. #2577 stored new ones off, but the
-- pickers still offered them and a quarter of new connects ticked them, and
-- older ones were never switched off. On 2026-09-29, 17 companies had one
-- enabled, with 439 open twin rows and 0 ever booked. The same PR makes the
-- selection save refuse them and the pickers stop offering them; this turns
-- off the ones already on.
--
-- Per account, in its own sub-block (a busy or failing company is skipped
-- and reported, the rest commit):
--   1. claim the connection's sync lease the way claimSyncLease does, and
--      skip the company when a sync holds it: a sync that loaded the
--      account list before this commit would otherwise hit the disabled
--      account and park the whole connection in 'error';
--   2. ignore the open rows (never a booked one: is_transaction_booked);
--   3. set enabled:false on the accounts_data entry (one statement, so a
--      concurrent balance write cannot be lost) and on the cash_accounts
--      row, together: sync refuses an account whose two stores disagree.
--      mirror_card_account:true keeps the pre-fix picker's note working.
--
-- No journal entry, chart account or ledger number is touched. Companies
-- that are a migration-reset source are skipped (their rows are immutable).
-- Idempotent: a second run finds nothing, so re-run it for skipped ones.
-- Run the dry run first and compare it with what the repair reports.

-- Dry run: what will be switched off
select ca.company_id, ca.id as cash_account_id, ca.name, ca.ledger_account,
       ca.bank_connection_id, bc.status as connection_status, bc.sync_lease_until,
       (select count(*) from transactions t
         where t.company_id = ca.company_id and t.cash_account_id = ca.id
           and not t.is_ignored and t.journal_entry_id is null
           and not public.is_transaction_booked(t.id)) as rows_to_ignore
from cash_accounts ca
left join bank_connections bc on bc.id = ca.bank_connection_id
where ca.enabled
  and ca.name in ('BOKIO_Debit_Business', 'SVEA_MQ_Debit_B2B')
  and coalesce(btrim(ca.iban), '') = ''
  and coalesce(btrim(ca.bban), '') = ''
  and not exists (select 1 from company_migration_resets r where r.source_company_id = ca.company_id)
order by rows_to_ignore desc;

-- Repair: one report row per account, returned by the final select
drop table if exists pg_temp.svea_card_repair;
create temp table svea_card_repair (
  company_id uuid, cash_account_id uuid, outcome text, rows_ignored integer
);

do $$
declare
  t record;
  v_ignored integer;
begin
  perform set_config('gnubok.actor_type', 'system', true);
  perform set_config('gnubok.actor_label', 'scripts/repair-svea-mirror-card-accounts.sql (issue #2565)', true);

  for t in
    select ca.id as cash_account_id, ca.company_id, ca.external_uid, ca.bank_connection_id
    from public.cash_accounts ca
    where ca.enabled
      and ca.name in ('BOKIO_Debit_Business', 'SVEA_MQ_Debit_B2B')
      and coalesce(btrim(ca.iban), '') = ''
      and coalesce(btrim(ca.bban), '') = ''
      and not exists (select 1 from public.company_migration_resets r where r.source_company_id = ca.company_id)
    order by ca.company_id
  loop
    begin
      if t.bank_connection_id is not null then
        update public.bank_connections
           set sync_lease_until = now() + interval '15 minutes'
         where id = t.bank_connection_id
           and company_id = t.company_id
           and sync_lease_until <= now();
        if not found then
          insert into svea_card_repair values (t.company_id, t.cash_account_id, 'skipped: sync lease held', 0);
          continue;
        end if;
      end if;

      update public.transactions tx
         set is_ignored = true
       where tx.company_id = t.company_id
         and tx.cash_account_id = t.cash_account_id
         and not tx.is_ignored
         and tx.journal_entry_id is null
         and not public.is_transaction_booked(tx.id);
      get diagnostics v_ignored = row_count;

      if t.bank_connection_id is not null then
        update public.bank_connections bc
           set accounts_data = (
             select jsonb_agg(
                      case when a.e->>'uid' = t.external_uid
                           then a.e || jsonb_build_object('enabled', false, 'mirror_card_account', true)
                           else a.e end
                      order by a.ord)
               from jsonb_array_elements(bc.accounts_data) with ordinality as a(e, ord))
         where bc.id = t.bank_connection_id
           and bc.company_id = t.company_id
           and exists (select 1 from jsonb_array_elements(bc.accounts_data) x where x->>'uid' = t.external_uid);
        if not found then
          -- Turning off only the cash row would make sync refuse the whole
          -- connection: roll this company back instead.
          raise exception 'accounts_data has no entry for uid %', t.external_uid;
        end if;
      end if;

      update public.cash_accounts
         set enabled = false
       where id = t.cash_account_id
         and company_id = t.company_id;

      insert into svea_card_repair values (t.company_id, t.cash_account_id, 'repaired', v_ignored);
    exception when others then
      insert into svea_card_repair values (t.company_id, t.cash_account_id, 'skipped: ' || sqlerrm, 0);
    end;
  end loop;
end $$;

select * from svea_card_repair order by outcome, company_id;
