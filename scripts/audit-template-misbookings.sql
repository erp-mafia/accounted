-- Read-only audit for posted entries that a defective booking template may have
-- mis-classified. Covers the two defects fixed in #1396 and #1397 whose bad
-- postings succeeded and therefore may remain in customers' ledgers.
--
-- Not covered, deliberately: vehicle_parking (5614) and it_cloud_hosting (5421)
-- named accounts that never existed in BAS, so account-backfill could not seed
-- them and every booking through those templates failed. Nothing was posted.
--
-- This query is diagnostic, not a list of confirmed errors. There is no
-- provenance link from a posted entry back to the template that produced it.
-- Both signatures also have legitimate shapes: 5820 is correct for actual car
-- hire, and representation can lawfully carry 25% VAT when the supply itself is
-- subject to 25% and the invoice is correct. Review the underlag before acting.
--
-- The query performs no writes, creates no objects, and returns one row per
-- posted journal entry and defect. Companion procedure:
-- docs/TEMPLATE_MISBOOKING_REMEDIATION.md.

with debit_line_groups as (
  -- Aggregate before classification so entries with several 6072 or 2641
  -- lines are evaluated once. This avoids the previous many-to-many pairing.
  select
    jel.journal_entry_id,
    jel.account_number,
    array_agg(jel.id order by jel.sort_order, jel.id) as line_ids,
    sum(jel.debit_amount) as debit_amount
  from public.journal_entry_lines jel
  where jel.account_number in ('5820', '6072', '2641')
    and jel.debit_amount > 0
  group by jel.journal_entry_id, jel.account_number
),

candidate_entry_ids as (
  select distinct journal_entry_id
  from debit_line_groups
  where account_number in ('5820', '6072')
),

transaction_refs as (
  select
    t.journal_entry_id,
    concat_ws(' ', nullif(t.merchant_name, ''), nullif(t.description, '')) as transaction_description
  from public.transactions t
  join candidate_entry_ids candidate on candidate.journal_entry_id = t.journal_entry_id
  where t.journal_entry_id is not null

  union all

  select
    tvl.journal_entry_id,
    concat_ws(' ', nullif(t.merchant_name, ''), nullif(t.description, '')) as transaction_description
  from public.transaction_voucher_links tvl
  join candidate_entry_ids candidate on candidate.journal_entry_id = tvl.journal_entry_id
  join public.transactions t on t.id = tvl.transaction_id
),

transaction_context as (
  select
    journal_entry_id,
    string_agg(
      distinct transaction_description,
      ' | ' order by transaction_description
    ) as transaction_description
  from transaction_refs
  group by journal_entry_id
),

hotel_candidates as (
  -- The Hotell template debited 5820 (Hyrbilskostnader) instead of 5830
  -- (Kost och logi) until #1397.
  select
    'travel_hotel_5820'::text as defect,
    je.company_id,
    je.id as journal_entry_id,
    je.voucher_series,
    je.voucher_number,
    je.entry_date,
    je.committed_at,
    je.fiscal_period_id,
    cost.line_ids as cost_line_ids,
    coalesce(vat.line_ids, '{}'::uuid[]) as vat_line_ids,
    '5820'::text as observed_cost_account,
    '5830'::text as expected_cost_account,
    case when vat.line_ids is null then null else '2641'::text end as observed_vat_account,
    case when vat.line_ids is null then null else '2641'::text end as expected_vat_account,
    cost.debit_amount as cost_debit_amount,
    vat.debit_amount as vat_debit_amount,
    round(vat.debit_amount / nullif(cost.debit_amount, 0), 6) as observed_vat_rate,
    0.12::numeric as expected_vat_rate,
    tx.transaction_description,
    case
      when tx.transaction_description ~* '(hotel|hotell|scandic|elite|best western|nordic choice|clarion|quality inn|radisson|booking\.com|airbnb|logi|övernattning)'
        then 'high_hotel_counterparty_on_car_hire_account'
      when abs(vat.debit_amount - cost.debit_amount * 0.12) < 0.02
        then 'medium_12pct_vat_on_car_hire_account'
      else 'manual_review_5820_no_corroborating_signal'
    end::text as review_priority
  from public.journal_entries je
  join debit_line_groups cost
    on cost.journal_entry_id = je.id and cost.account_number = '5820'
  left join debit_line_groups vat
    on vat.journal_entry_id = je.id and vat.account_number = '2641'
  left join transaction_context tx on tx.journal_entry_id = je.id
  where je.status = 'posted'
),

representation_candidates as (
  -- The representation template deducted 25% input VAT on what was intended
  -- to be a 12% restaurant supply until #1396. Totals are evaluated per entry,
  -- never by pairing individual lines.
  select
    'representation_25pct_vat'::text as defect,
    je.company_id,
    je.id as journal_entry_id,
    je.voucher_series,
    je.voucher_number,
    je.entry_date,
    je.committed_at,
    je.fiscal_period_id,
    cost.line_ids as cost_line_ids,
    vat.line_ids as vat_line_ids,
    '6072'::text as observed_cost_account,
    '6072'::text as expected_cost_account,
    '2641'::text as observed_vat_account,
    '2641'::text as expected_vat_account,
    cost.debit_amount as cost_debit_amount,
    vat.debit_amount as vat_debit_amount,
    round(vat.debit_amount / nullif(cost.debit_amount, 0), 6) as observed_vat_rate,
    0.12::numeric as expected_vat_rate,
    tx.transaction_description,
    case
      when abs(vat.debit_amount - cost.debit_amount * 0.25) < 0.02
        then 'high_vat_is_25pct_of_6072_cost'
      else 'manual_review_6072_with_vat'
    end::text as review_priority
  from public.journal_entries je
  join debit_line_groups cost
    on cost.journal_entry_id = je.id and cost.account_number = '6072'
  join debit_line_groups vat
    on vat.journal_entry_id = je.id and vat.account_number = '2641'
  left join transaction_context tx on tx.journal_entry_id = je.id
  where je.status = 'posted'
),

all_candidates as (
  select
    defect,
    company_id,
    journal_entry_id,
    voucher_series,
    voucher_number,
    entry_date,
    committed_at,
    fiscal_period_id,
    cost_line_ids,
    vat_line_ids,
    observed_cost_account,
    expected_cost_account,
    observed_vat_account,
    expected_vat_account,
    cost_debit_amount,
    vat_debit_amount,
    observed_vat_rate,
    expected_vat_rate,
    transaction_description,
    review_priority
  from hotel_candidates

  union all

  select
    defect,
    company_id,
    journal_entry_id,
    voucher_series,
    voucher_number,
    entry_date,
    committed_at,
    fiscal_period_id,
    cost_line_ids,
    vat_line_ids,
    observed_cost_account,
    expected_cost_account,
    observed_vat_account,
    expected_vat_account,
    cost_debit_amount,
    vat_debit_amount,
    observed_vat_rate,
    expected_vat_rate,
    transaction_description,
    review_priority
  from representation_candidates
),

entry_line_snapshots as (
  -- Retain every field accepted by gnubok_correct_entry for candidate entries
  -- only, without scanning and serializing the entire journal-line table.
  select
    jel.journal_entry_id,
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'account_number', jel.account_number,
        'debit_amount', jel.debit_amount,
        'credit_amount', jel.credit_amount,
        'line_description', jel.line_description,
        'currency', jel.currency,
        'amount_in_currency', jel.amount_in_currency,
        'exchange_rate', jel.exchange_rate,
        'tax_code', jel.tax_code,
        'dimensions', jel.dimensions
      ))
      order by jel.sort_order, jel.id
    ) as original_lines
  from public.journal_entry_lines jel
  join (
    select distinct journal_entry_id
    from all_candidates
  ) candidate on candidate.journal_entry_id = jel.journal_entry_id
  group by jel.journal_entry_id
)

select
  c.defect,
  c.company_id,
  co.name as company_name,
  c.journal_entry_id,
  c.voucher_series,
  c.voucher_number,
  c.entry_date,
  c.committed_at,
  c.fiscal_period_id,
  c.cost_line_ids,
  c.vat_line_ids,
  c.observed_cost_account,
  c.expected_cost_account,
  c.observed_vat_account,
  c.expected_vat_account,
  c.cost_debit_amount,
  c.vat_debit_amount,
  c.observed_vat_rate,
  c.expected_vat_rate,
  c.transaction_description,
  c.review_priority,
  lines.original_lines,
  case
    when fp.id is null then 'missing_fiscal_period'
    when fp.is_closed then 'closed'
    when fp.locked_at is not null then 'locked'
    when cs.bookkeeping_locked_through is not null
      and c.entry_date <= cs.bookkeeping_locked_through then 'behind_company_lock_date'
    else 'open'
  end as effective_lock_status
from all_candidates c
join public.companies co on co.id = c.company_id
join entry_line_snapshots lines on lines.journal_entry_id = c.journal_entry_id
left join public.company_settings cs on cs.company_id = c.company_id
left join public.fiscal_periods fp on fp.id = c.fiscal_period_id
order by
  c.defect,
  case
    when c.review_priority like 'high%' then 0
    when c.review_priority like 'medium%' then 1
    else 2
  end,
  c.entry_date desc;
