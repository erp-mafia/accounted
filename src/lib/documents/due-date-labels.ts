/**
 * How a Swedish invoice prints its payment due date, for the extraction
 * prompts that read one (the Inkorg's invoice reader in
 * inbox-extraction/extract-invoice-fields.ts and the Arkiv schemas in
 * extract/schemas.ts). An invoice that said only "Oss tillhanda: 25-11-2026"
 * came back with no due date, so the supplier's terms were used in its place
 * (crm#1610). One wording for both readers.
 */
export const DUE_DATE_LABELS = [
  'Förfallodatum',
  'Förfaller',
  'Oss tillhanda',
  'Oss tillhanda senast',
  'Betalas senast',
  'Att betala senast',
  'Sista betalningsdag',
] as const

/** The rule text: what the label means and how a day-first date is written out. */
export const DUE_DATE_RULE =
  `the date the payment must reach the seller, however it is labelled: ${DUE_DATE_LABELS.map((l) => `"${l}"`).join(', ')} or "Due date". ` +
  'On a Swedish or European document a numeric date is day first: 25-11-2026, 25.11.2026 and 25/11/2026 are all 2026-11-25.'
