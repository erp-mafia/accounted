-- Read-only evidence-classifier probes for audit-template-misbookings.sql.
-- Expected result: eight rows, each with passed = true.

with probes(
  probe,
  defect,
  source_type,
  review_priority,
  line_count,
  observed_vat_rate,
  document_has_12pct_vat,
  document_has_25pct_vat,
  expected_classification
) as (
  values
    (
      'exact_hotel_template_shape',
      'travel_hotel_5820', 'manual',
      'high_hotel_counterparty_on_car_hire_account',
      3, 0.12::numeric, false, false, 'confirmed_correction'
    ),
    (
      'car_hire_with_25pct_vat',
      'travel_hotel_5820', 'manual',
      'manual_review_5820_no_corroborating_signal',
      3, 0.25::numeric, false, false, 'false_positive'
    ),
    (
      'hotel_shape_without_hotel_evidence',
      'travel_hotel_5820', 'manual',
      'medium_12pct_vat_on_car_hire_account',
      3, 0.12::numeric, false, false, 'insufficient_evidence'
    ),
    (
      'imported_representation_signature',
      'representation_25pct_vat', 'import',
      'high_vat_is_25pct_of_6072_cost',
      3, 0.25::numeric, false, false, 'false_positive'
    ),
    (
      'live_representation_without_underlag',
      'representation_25pct_vat', 'manual',
      'high_vat_is_25pct_of_6072_cost',
      3, 0.25::numeric, false, false, 'insufficient_evidence'
    ),
    (
      'live_representation_with_25pct_underlag',
      'representation_25pct_vat', 'manual',
      'high_vat_is_25pct_of_6072_cost',
      3, 0.25::numeric, false, true, 'false_positive'
    ),
    (
      'live_representation_with_12pct_vat',
      'representation_25pct_vat', 'manual',
      'manual_review_6072_with_vat',
      3, 0.12::numeric, true, false, 'false_positive'
    ),
    (
      'mixed_representation_without_underlag',
      'representation_25pct_vat', 'manual',
      'manual_review_6072_with_vat',
      4, 0.18::numeric, false, false, 'insufficient_evidence'
    )
),
classified as (
  select
    probe.*,
    case
      when source_type in ('import', 'correction') then 'false_positive'
      when defect = 'representation_25pct_vat'
        and review_priority = 'high_vat_is_25pct_of_6072_cost'
        and document_has_25pct_vat
        and not document_has_12pct_vat
        then 'false_positive'
      when defect = 'representation_25pct_vat'
        and review_priority = 'high_vat_is_25pct_of_6072_cost'
        then 'insufficient_evidence'
      when defect = 'representation_25pct_vat'
        and observed_vat_rate between 0.119 and 0.121
        then 'false_positive'
      when defect = 'representation_25pct_vat'
        and document_has_12pct_vat
        and not document_has_25pct_vat
        then 'false_positive'
      when defect = 'representation_25pct_vat' then 'insufficient_evidence'
      when defect = 'travel_hotel_5820'
        and line_count = 3
        and observed_vat_rate between 0.119 and 0.121
        and review_priority = 'high_hotel_counterparty_on_car_hire_account'
        then 'confirmed_correction'
      when defect = 'travel_hotel_5820'
        and line_count = 3
        and observed_vat_rate between 0.119 and 0.121
        then 'insufficient_evidence'
      else 'false_positive'
    end as actual_classification
  from probes probe
)

select
  probe,
  expected_classification,
  actual_classification,
  actual_classification = expected_classification as passed
from classified
order by probe;
