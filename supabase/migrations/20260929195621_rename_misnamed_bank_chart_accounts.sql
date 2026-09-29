-- Rename bank chart accounts that carry another currency's name.
--
-- Root cause (fixed in code in the same change): the onboarding bank step
-- chose 19xx slots and named the chart rows it created with its own copy of
-- the server rule. The copy handed the currency defaults 1932, 1933 and 1934
-- to accounts of other currencies and named each new row after its number, so
-- a SEK account became "1932 Bankkonto EUR". The server names a free-use bank
-- account after the account's own currency ("Bankkonto SEK"); both now share
-- lib/cash-accounts/ledger-slots.ts.
--
-- Prod state when this was written: 41 cash accounts on 1932 to 1934 whose
-- chart row carries a generated currency name that is not their currency (38
-- SEK named "Bankkonto EUR", 2 SEK named "Bankkonto USD", 1 EUR named
-- "Bankkonto USD"), all created from 2026-09-14 on.
--
-- Only the name changes (and the description where it repeats that name),
-- and only while it is still exactly the generated "Bankkonto EUR/USD/GBP":
-- an account someone renamed keeps its name. The account number, the cash
-- account and every posted line stay as they are.
--
-- audit_chart_of_accounts writes one audit_log row per renamed account,
-- tagged actor_type = 'system' so it does not read as the owner's change.
-- Re-runnable: a renamed row no longer matches.

do $$
begin
  perform set_config('gnubok.actor_type', 'system', true);
  perform set_config(
    'gnubok.actor_label',
    'migration 20260929195621 rename_misnamed_bank_chart_accounts',
    true
  );

  -- SET expressions read the row as it was, so the description comparison
  -- sees the old name.
  update public.chart_of_accounts coa
     set account_name = 'Bankkonto ' || upper(ca.currency),
         description = case
           when coa.description = coa.account_name then 'Bankkonto ' || upper(ca.currency)
           else coa.description
         end
    from public.cash_accounts ca
   where ca.company_id = coa.company_id
     and ca.ledger_account = coa.account_number
     and coa.account_number in ('1932', '1933', '1934')
     and coa.account_name in ('Bankkonto EUR', 'Bankkonto USD', 'Bankkonto GBP')
     and coa.account_name <> 'Bankkonto ' || upper(ca.currency);
end $$;
