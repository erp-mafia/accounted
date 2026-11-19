export default {
  rule: 'reskontra-bucket-display',
  says: 'A row of the aged reskontra shows the same buckets on the page, the PDF and the xlsx: blank at zero only.',
  home: 'src/components/reports/report-view-shared.tsx: agingCell',
  why: 'The page hid a bucket unless it was above zero, so a credit note not yet due left a row that did not add up to its own Totalt.',
  match: [/\b(?:current|days_\d+_\d+|days_90_plus)\s*>\s*0\s*\?\s*formatAmount/],
}
