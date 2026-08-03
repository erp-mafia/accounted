-- Read-only audit for journal entries whose settlement leg may disagree with
-- the cash account linked to the source bank transaction.
--
-- This query is deliberately diagnostic. A current cash_account_id does not
-- prove that the same link existed when the entry was posted. Every result
-- therefore requires review against the bank feed, the original journal entry,
-- and the transaction history before any correction is staged.
--
-- The query performs no writes, creates no temporary objects, and only returns
-- current posted entries. Reversed originals disappear once their transaction
-- is linked to the posted correction.

with transaction_context as (
  select
    t.company_id,
    t.id as transaction_id,
    t.date as transaction_date,
    t.amount as transaction_amount,
    coalesce(t.currency, 'SEK') as transaction_currency,
    t.amount_sek,
    t.exchange_rate,
    t.cash_account_id,
    t.import_source,
    t.created_at as transaction_created_at,
    t.updated_at as transaction_updated_at,
    je.id as journal_entry_id,
    je.entry_date,
    je.committed_at,
    je.voucher_series,
    je.voucher_number,
    je.fiscal_period_id,
    ca.ledger_account as expected_settlement_account,
    ca.created_at as cash_account_created_at,
    fp.name as fiscal_period_name,
    fp.is_closed as fiscal_period_closed,
    fp.locked_at as fiscal_period_locked_at,
    cs.bookkeeping_locked_through,
    round(
      abs(
        case
          when coalesce(t.currency, 'SEK') = 'SEK' then t.amount
          when t.amount_sek is not null then t.amount_sek
          when t.exchange_rate is not null then t.amount * t.exchange_rate
          else null
        end
      ),
      2
    ) as settlement_amount_sek,
    exists (
      select 1
      from public.invoice_payments ip
      where ip.transaction_id = t.id
        and ip.journal_entry_id = je.id
    ) as is_customer_invoice_payment,
    exists (
      select 1
      from public.supplier_invoice_payments sip
      where sip.transaction_id = t.id
        and sip.journal_entry_id = je.id
    ) as is_supplier_invoice_payment
  from public.transactions t
  join public.journal_entries je
    on je.id = t.journal_entry_id
   and je.company_id = t.company_id
   and je.status = 'posted'
  join public.cash_accounts ca
    on ca.id = t.cash_account_id
   and ca.company_id = t.company_id
  join public.fiscal_periods fp
    on fp.id = je.fiscal_period_id
   and fp.company_id = t.company_id
  left join public.company_settings cs
    on cs.company_id = t.company_id
), directional_exact_lines as (
  select
    tc.*,
    jel.id as observed_line_id,
    jel.account_number as observed_settlement_account,
    jel.debit_amount as observed_debit_amount,
    jel.credit_amount as observed_credit_amount,
    count(*) over (partition by tc.transaction_id, tc.journal_entry_id) as exact_directional_line_count
  from transaction_context tc
  join public.journal_entry_lines jel
    on jel.journal_entry_id = tc.journal_entry_id
   and case
     when tc.transaction_amount < 0 then
       round(jel.credit_amount, 2) = tc.settlement_amount_sek
       and round(jel.debit_amount, 2) = 0
     else
       round(jel.debit_amount, 2) = tc.settlement_amount_sek
       and round(jel.credit_amount, 2) = 0
   end
  where tc.settlement_amount_sek is not null
), candidates as (
  select dl.*
  from directional_exact_lines dl
  where dl.observed_settlement_account <> dl.expected_settlement_account
    and not exists (
      select 1
      from public.journal_entry_lines expected
      where expected.journal_entry_id = dl.journal_entry_id
        and expected.account_number = dl.expected_settlement_account
        and case
          when dl.transaction_amount < 0 then
            round(expected.credit_amount, 2) = dl.settlement_amount_sek
            and round(expected.debit_amount, 2) = 0
          else
            round(expected.debit_amount, 2) = dl.settlement_amount_sek
            and round(expected.credit_amount, 2) = 0
        end
    )
)
select
  c.company_id,
  c.transaction_id,
  c.journal_entry_id,
  c.observed_line_id,
  concat(c.voucher_series, '-', c.voucher_number) as voucher,
  c.transaction_date,
  c.entry_date,
  c.committed_at,
  c.transaction_amount,
  c.transaction_currency,
  c.settlement_amount_sek,
  c.expected_settlement_account,
  c.observed_settlement_account,
  c.observed_debit_amount,
  c.observed_credit_amount,
  c.exact_directional_line_count,
  c.cash_account_id,
  c.import_source,
  c.transaction_created_at,
  c.transaction_updated_at,
  c.cash_account_created_at,
  c.fiscal_period_id,
  c.fiscal_period_name,
  c.fiscal_period_closed,
  c.fiscal_period_locked_at,
  c.bookkeeping_locked_through,
  case
    when c.fiscal_period_closed then 'closed'
    when c.fiscal_period_locked_at is not null then 'period_locked'
    when c.bookkeeping_locked_through is not null
      and c.entry_date <= c.bookkeeping_locked_through
      then 'company_lock_date'
    else 'open'
  end as effective_lock_status,
  (
    select jsonb_agg(
      jsonb_build_object(
        'account_number', original.account_number,
        'debit_amount', original.debit_amount,
        'credit_amount', original.credit_amount,
        'line_description', original.line_description,
        'currency', original.currency,
        'amount_in_currency', original.amount_in_currency,
        'exchange_rate', original.exchange_rate,
        'tax_code', original.tax_code,
        'dimensions', original.dimensions,
        'cost_center', original.cost_center,
        'project', original.project
      )
      order by original.sort_order, original.id
    )
    from public.journal_entry_lines original
    where original.journal_entry_id = c.journal_entry_id
  ) as original_lines,
  case
    when c.is_customer_invoice_payment then 'customer_invoice_payment'
    when c.is_supplier_invoice_payment then 'supplier_invoice_payment'
    else 'categorization_or_manual_link'
  end as booking_flow,
  case
    when c.exact_directional_line_count <> 1 then 'manual_review_multiple_exact_lines'
    when c.is_customer_invoice_payment or c.is_supplier_invoice_payment
      then 'manual_review_payment_aware_correction_required'
    when c.cash_account_created_at > c.committed_at then 'manual_review_cash_account_created_later'
    when c.expected_settlement_account <> '1930'
      and c.observed_settlement_account = '1930'
      and abs(extract(epoch from (c.transaction_updated_at - c.committed_at))) <= 60
      then 'high_review_priority_hardcoded_1930_signature'
    else 'manual_review_link_history_required'
  end as review_priority
from candidates c
order by
  case
    when c.expected_settlement_account <> '1930'
      and c.observed_settlement_account = '1930'
      and c.cash_account_created_at <= c.committed_at
      and abs(extract(epoch from (c.transaction_updated_at - c.committed_at))) <= 60
      then 1
    when c.is_customer_invoice_payment or c.is_supplier_invoice_payment then 2
    else 3
  end,
  c.company_id,
  c.entry_date,
  c.voucher_series,
  c.voucher_number;
