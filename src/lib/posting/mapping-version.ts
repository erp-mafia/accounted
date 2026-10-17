import { currentAppVersion } from '@/lib/reports/app-version'

/**
 * mapping_version: which rule produced a posting's lines, and in which
 * version. BFNAR 2013:2 p. 9.16 asks the behandlingshistorik to date changes
 * to automatic booking rules (automatkonteringar); an event that names its
 * rule source and version lets a reader match a booking to the rules in
 * force when it was made.
 *
 *   <source>@<version>     e.g. se.category-mapping@bank-proposals.1+a38016f12abc
 *
 * The source is where the kontering came from. The Swedish category mapping,
 * the static booking template catalogue and the auto-booking ladder of the
 * mapping engine (lib/bookkeeping/mapping-engine.ts: rules, learned
 * templates, catalogue, default) are Sweden-only rule sets and carry the se.
 * prefix; a counterparty template and a mapping rule are the company's own
 * learned or saved data (their ids go into the evidence). The producers'
 * own line rules are Sweden-only too: the utlägg lines
 * (lib/expenses/expense-claims-service.ts, expense-claim-vat.ts), the
 * milersättning lines at the year's schablon (lib/mileage), the kassa day's
 * tender, VAT group and tips lines (lib/pos-sales/evaluate.ts, with the
 * connection's account settings) and the webbshop prefill
 * (lib/webshop-orders/booking-lines.ts).
 *
 * The version is the rubric version the producer already records on the
 * verifikat (journal_entries.rubric_version: the proposal rule revision plus
 * the build), else the build alone (currentAppVersion), else 'unversioned'
 * (a local build without a commit id). The rules live in code, so the build
 * identifies them.
 */
export const MAPPING_SOURCES = {
  category: 'se.category-mapping',
  bookingTemplate: 'se.booking-template',
  counterpartyTemplate: 'counterparty-template',
  mappingRule: 'mapping-rule',
  mappingEngine: 'se.mapping-engine',
  expenseClaim: 'se.expense-claim',
  mileageAllowance: 'se.mileage-allowance',
  posDailyTakings: 'se.pos-daily-takings',
  webshopOrder: 'se.webshop-order-lines',
} as const

export type MappingSource = keyof typeof MAPPING_SOURCES

export function mappingVersion(source: MappingSource, rubricVersion?: string | null): string {
  const version = rubricVersion || currentAppVersion() || 'unversioned'
  return `${MAPPING_SOURCES[source]}@${version}`.slice(0, 200)
}
