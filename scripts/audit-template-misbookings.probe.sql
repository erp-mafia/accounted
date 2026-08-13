-- Read-only classifier probes for scripts/audit-template-misbookings.sql.
-- Expected result: four rows, each with actual_result = expected_result.

with probe_lines(probe, account_number, debit_amount) as (
  values
    ('hotel_on_5820', '5820', 1000.00::numeric),
    ('hotel_on_5820', '2641', 120.00::numeric),
    ('car_hire_on_5820', '5820', 1000.00::numeric),
    ('car_hire_on_5820', '2641', 250.00::numeric),
    ('representation_25_multi_line', '6072', 60.00::numeric),
    ('representation_25_multi_line', '6072', 40.00::numeric),
    ('representation_25_multi_line', '2641', 10.00::numeric),
    ('representation_25_multi_line', '2641', 15.00::numeric),
    ('representation_25_with_extra_vat', '6072', 100.00::numeric),
    ('representation_25_with_extra_vat', '2641', 25.00::numeric),
    ('representation_25_with_extra_vat', '2641', 20.00::numeric),
    ('representation_12', '6072', 100.00::numeric),
    ('representation_12', '2641', 12.00::numeric)
),
probe_context(probe, transaction_description, expected_result) as (
  values
    ('hotel_on_5820', 'Scandic Stockholm', 'high_hotel_counterparty_on_car_hire_account'),
    ('car_hire_on_5820', 'Hertz rental car', 'manual_review_5820_no_corroborating_signal'),
    ('representation_25_multi_line', 'Customer dinner', 'high_vat_is_25pct_of_6072_cost'),
    ('representation_25_with_extra_vat', 'Mixed expense voucher', 'manual_review_6072_with_vat'),
    ('representation_12', 'Customer dinner', 'manual_review_6072_with_vat')
),
line_groups as (
  select probe, account_number, sum(debit_amount) as debit_amount
  from probe_lines
  group by probe, account_number
),
classified as (
  select
    context.probe,
    context.expected_result,
    case
      when hotel.debit_amount is not null
        and context.transaction_description ~* '(hotel|hotell|scandic|elite|best western|nordic choice|clarion|quality inn|radisson|booking\.com|airbnb|logi|övernattning)'
        then 'high_hotel_counterparty_on_car_hire_account'
      when hotel.debit_amount is not null
        and abs(coalesce(vat.debit_amount, 0) - hotel.debit_amount * 0.12) < 0.02
        then 'medium_12pct_vat_on_car_hire_account'
      when hotel.debit_amount is not null
        then 'manual_review_5820_no_corroborating_signal'
      when representation.debit_amount is not null
        and abs(coalesce(vat.debit_amount, 0) - representation.debit_amount * 0.25) < 0.02
        then 'high_vat_is_25pct_of_6072_cost'
      when representation.debit_amount is not null and vat.debit_amount is not null
        then 'manual_review_6072_with_vat'
      else 'absent'
    end as actual_result
  from probe_context context
  left join line_groups hotel
    on hotel.probe = context.probe and hotel.account_number = '5820'
  left join line_groups representation
    on representation.probe = context.probe and representation.account_number = '6072'
  left join line_groups vat
    on vat.probe = context.probe and vat.account_number = '2641'
)

select
  probe,
  expected_result,
  actual_result,
  actual_result = expected_result as passed
from classified
order by probe;
