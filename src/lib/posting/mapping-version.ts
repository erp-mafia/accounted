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
 * connection's account settings), the webbshop prefill
 * (lib/webshop-orders/booking-lines.ts), the momsredovisning proposal
 * (lib/reports/vat-settlement.ts), the skattekonto rules (skattekonto_rules:
 * the system seeds and the company's own rows, the skatteverket extension's
 * skattekonto-booking.ts), the skattekonto account transfer
 * (lib/skatteverket/skattekonto-account-service.ts), the planenlig
 * avskrivning (lib/bokslut/assets/depreciation-engine.ts), the disposal
 * plan with its jämkning (buildAssetDisposalPlan in asset-service.ts), the
 * salary run's verifikat (buildSalaryRunEntryLines and the account mapping
 * in lib/salary), the semesterårsavslut's drift adjustment
 * (commitVacationYearClose in lib/salary/semesterberedning.ts), the
 * supplier invoice's registration and credit note lines (the moms,
 * reverse-charge, SLP and 2440 rows of
 * lib/bookkeeping/supplier-invoice-registration-lines.ts, which the credit
 * note books on the other side) and its payment lines (the 2440 clearing
 * with its kursdifferens, 3740 öresavrundning and 6570 bank fee, and the
 * kontantmetoden payment verifikat: buildSupplierInvoicePaymentLines and
 * buildSupplierInvoiceCashLines in lib/bookkeeping/supplier-invoice-entries.ts
 * and lib/bookkeeping/supplier-payment-lines.ts),
 * the customer invoice's registration and
 * kreditfaktura lines (lib/bookkeeping/invoice-lines.ts: the revenue account
 * per VAT treatment and rate, utgående moms, the 1510 and 1513 split of a
 * ROT/RUT invoice and the 29xx deferral of a periodisering; lines a person
 * edited in the send dialog name no rule), and the year-end block's: the
 * bokslutsverifikation (previewYearEndClosing: every result account onto the
 * form's closing account), the ingående balans (generateOpeningBalances: the
 * balance sheet's UB with its project split), the omföring of föregående års
 * resultat (result-appropriation-service.ts, also behind its historical
 * repair), the kontantmetod cut-off (buildCutoffLines), the balansdagen
 * revaluation (lib/bookkeeping/currency-revaluation.ts), the
 * bokslutsdispositioner (lib/bokslut's calculators), the accrual schedules'
 * monthly dissolutions (lib/bookkeeping/accruals/service.ts) and the year-end
 * wizard's periodiseringar (lib/bokslut/accruals/accrual-detector.ts).
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
  vatSettlement: 'se.vat-settlement',
  taxAccountRules: 'se.skattekonto-rules',
  taxAccountTransfer: 'se.skattekonto-account-transfer',
  assetDepreciation: 'se.asset-depreciation',
  assetDisposal: 'se.asset-disposal',
  salaryRun: 'se.salary-run',
  vacationYearClose: 'se.vacation-year-close',
  supplierInvoice: 'se.supplier-invoice-lines',
  customerInvoice: 'se.customer-invoice-lines',
  supplierPayment: 'se.supplier-payment-lines',
  yearEndClosing: 'se.year-end-closing',
  openingBalance: 'se.opening-balance',
  resultAppropriation: 'se.result-appropriation',
  kontantmetodCutoff: 'se.kontantmetod-cutoff',
  currencyRevaluation: 'se.currency-revaluation',
  yearEndDispositions: 'se.year-end-dispositions',
  accrualSchedule: 'se.accrual-schedule',
  yearEndAccruals: 'se.year-end-accruals',
} as const

export type MappingSource = keyof typeof MAPPING_SOURCES

export function mappingVersion(source: MappingSource, rubricVersion?: string | null): string {
  const version = rubricVersion || currentAppVersion() || 'unversioned'
  return `${MAPPING_SOURCES[source]}@${version}`.slice(0, 200)
}
