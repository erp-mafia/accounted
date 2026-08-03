-- Read-only audit for posted entries that a defective booking template may have
-- mis-classified. Covers the two defects fixed in #1396 and #1397 whose bad
-- postings SUCCEEDED and therefore still sit in customers' huvudböcker.
--
-- Not covered, deliberately: vehicle_parking (5614) and it_cloud_hosting (5421)
-- named accounts that never existed in BAS, so account-backfill could not seed
-- them and every booking through those templates failed. Nothing was ever
-- posted; there is nothing to remediate.
--
-- ## This query is DIAGNOSTIC, not a list of confirmed errors
--
-- There is no provenance link from a posted entry back to the template that
-- produced it (`template_id` lives on mapping_rules, not on journal_entries),
-- so candidates are identified by account signature. Both signatures have
-- legitimate shapes:
--
--   * 5820 Hyrbilskostnader is the CORRECT account for actual car hire.
--   * Representation at 25% is lawful when the underlag carries 25% VAT; the
--     swedish-vat skill's own table lists "All at 25% VAT" as a real scenario.
--
-- So a row here is a question, never a verdict. Never correct an entry from
-- this output alone: follow docs/TEMPLATE_MISBOOKING_REMEDIATION.md.
--
-- The query performs no writes, creates no objects, and returns only posted
-- entries.

with hotel_candidates as (
  -- Case A: the Hotell template debited 5820 (Hyrbilskostnader) instead of
  -- 5830 (Kost och logi) until #1397. The entry balanced and the account
  -- exists, so it posted cleanly and looks correct in the ledger.
  select
    'travel_hotel_5820' as defect,
    je.company_id,
    je.id as journal_entry_id,
    je.voucher_series,
    je.voucher_number,
    je.entry_date,
    je.committed_at,
    je.fiscal_period_id,
    jel.id as line_id,
    jel.account_number as observed_account,
    '5830' as expected_account,
    jel.debit_amount,
    jel.credit_amount,
    t.description as transaction_description,
    case
      -- A hotel-shaped counterparty on a 5820 line is the strong signal.
      when t.description ~* '(hotel|hotell|scandic|elite|best western|nordic choice|clarion|quality inn|radisson|booking\.com|airbnb|logi|övernattning)'
        then 'high_hotel_counterparty_on_car_hire_account'
      -- 12% VAT alongside 5820 is suggestive: car hire is 25%.
      when exists (
        select 1 from public.journal_entry_lines v
        where v.journal_entry_id = je.id
          and v.account_number = '2641'
          and v.debit_amount > 0
          and abs(v.debit_amount - jel.debit_amount * 0.12) < 0.02
      ) then 'medium_12pct_vat_on_car_hire_account'
      else 'manual_review_5820_no_corroborating_signal'
    end as review_priority
  from public.journal_entries je
  join public.journal_entry_lines jel on jel.journal_entry_id = je.id
  left join public.transactions t on t.journal_entry_id = je.id
  where je.status = 'posted'
    and jel.account_number = '5820'
    and jel.debit_amount > 0
),

representation_candidates as (
  -- Case B: the representation template deducted 25% input VAT on what is a
  -- 12% restaurang supply until #1396. Signature: a 6072 cost line whose
  -- companion 2641 line is ~25% of it rather than ~12%.
  select
    'representation_25pct_vat' as defect,
    je.company_id,
    je.id as journal_entry_id,
    je.voucher_series,
    je.voucher_number,
    je.entry_date,
    je.committed_at,
    je.fiscal_period_id,
    vat.id as line_id,
    '2641 @ 25%' as observed_account,
    '2641 @ 12%' as expected_account,
    vat.debit_amount,
    cost.debit_amount as credit_amount,   -- reusing the column to carry the cost leg
    t.description as transaction_description,
    case
      when abs(vat.debit_amount - cost.debit_amount * 0.25) < 0.02
        then 'high_vat_is_25pct_of_6072_cost'
      else 'manual_review_6072_with_vat'
    end as review_priority
  from public.journal_entries je
  join public.journal_entry_lines cost
    on cost.journal_entry_id = je.id and cost.account_number = '6072' and cost.debit_amount > 0
  join public.journal_entry_lines vat
    on vat.journal_entry_id = je.id and vat.account_number = '2641' and vat.debit_amount > 0
  left join public.transactions t on t.journal_entry_id = je.id
  where je.status = 'posted'
    -- Only the 25%-shaped ones. A 12% companion is already correct.
    and abs(vat.debit_amount - cost.debit_amount * 0.25) < 0.02
)

select
  c.*,
  -- Lock state decides whether the ordinary correction flow is even available.
  -- Both the period's own flags and the company-wide lock date are
  -- authoritative; any value other than 'open' is a hard stop.
  case
    when fp.is_closed then 'closed'
    when fp.locked_at is not null then 'locked'
    when cs.bookkeeping_locked_through is not null
      and c.entry_date <= cs.bookkeeping_locked_through then 'behind_company_lock_date'
    else 'open'
  end as effective_lock_status,
  co.name as company_name
from (
  select * from hotel_candidates
  union all
  select * from representation_candidates
) c
join public.companies co on co.id = c.company_id
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
