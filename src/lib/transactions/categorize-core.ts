/**
 * Booking a bank transaction by category: the one implementation behind every
 * categorize door.
 *
 * `categorizeTransaction` is the service; the doors only parse their input
 * and render its outcome:
 *   1. The dashboard route POST /api/transactions/{id}/categorize.
 *   2. The v1 routes :categorize and batch-categorize (a loop over the same
 *      call, with the batch's exclusions and one suggestion snapshot).
 *   3. The approval executor `commitCategorizeTransaction` and the
 *      bulk-book-inbox driver below, through `categorizeMatchedTransaction`,
 *      which keeps the executor's result shape.
 *   4. The MCP tool gnubok_categorize_transaction, whose staging preview is
 *      the service's dry run.
 * A dry run runs every read-only check the booking runs (bookable, duplicate,
 * template, mapping, override, counter legs, chart, invoice match, period
 * lock) and answers with the lines it would post, so a preview that passes
 * is one the booking accepts.
 *
 * "Booking an underlag" in the Dokumentinkorgen is categorizing the bank
 * transaction it is matched to: the propagation step attaches the underlag to
 * the new verifikation (BFL 7 kap) and stamps the inbox item resolved.
 *
 * Journal entry lines are always SEK (BFL 5 kap 2§), but transaction.amount is
 * denominated in transaction.currency: the SEK resolution happens inside the
 * mapping builders and buildTransactionEntryLines (amount_sek / exchange_rate,
 * see lib/bookkeeping/currency-utils.ts), never off the raw amount.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { fiscalYearStartMonthFor } from '@/lib/company/fiscal-year'
import { eventBus } from '@/lib/events'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { applyAccountOverride } from '@/lib/bookkeeping/account-override'
import { applyVatAmountOverride } from '@/lib/bookkeeping/vat-amount-override'
import {
  getTemplateById,
  buildMappingResultFromTemplate,
  templateSkattekontoAccountFor,
  validateTemplateForEntity,
  type BookingTemplate,
} from '@/lib/bookkeeping/booking-templates'
import { isSkatteverketPayment } from '@/lib/bookkeeping/skatteverket-payment'
import { reconcileRcBasisWithCostLines, reverseChargeCostAccounts } from '@/lib/bookkeeping/rc-basis-reconcile'
import { reverseChargeAccountConflict, type ReverseChargeAccountConflict } from '@/lib/bookkeeping/voucher-line-vat-code'
import { chartVatTreatmentsLoader, type ChartVatTreatmentsLoader } from '@/lib/bookkeeping/chart-vat-treatments'
import { applySettlementAccount, saveUserMappingRule } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { coveredDayMessage, coveredFeedRows } from '@/lib/bookkeeping/feed-row-coverage'
import { learnableBankPair } from '@/lib/bookkeeping/bank-leg'
import { loadCardLedgers, needsCardLedgers } from '@/lib/cash-accounts/load-card-ledgers'
import { guardCounterLegs } from '@/lib/cash-accounts/service'
import { buildTransactionEntryLines, createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { finalFromCategorize, recordDecisions, snapshotSuggestions, type SuggestionSnapshot } from '@/lib/suggestion-log/record'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { bookedTotals } from '@/lib/suggestion-log/inbox-classify'
import { duplicateCheck, passed, warned, type DecisionCheck, type DuplicateVerdict } from '@/lib/suggestion-log/checks'
import { reviewReason } from './direct-booking'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { isCashAccountBusy, retryWhileCashAccountBusy } from '@/lib/bookkeeping/cash-account-busy'
import { insertFiscalYearAfter } from '@/lib/core/bookkeeping/period-service'
import { missingFiscalYears, scheduledFiscalYear } from '@/lib/bookkeeping/suggest-fiscal-period'
import {
  upsertCounterpartyTemplate,
  buildMappingResultFromCounterpartyTemplate,
  loadCounterpartyTemplateMatch,
} from '@/lib/bookkeeping/counterparty-templates'
import {
  AccountsNotInChartError,
  isBookkeepingError,
  TransactionMissingSekValueError,
  TransactionLinesNotBalancedError,
  UnattendedCommitLimitExceededError,
  BookingReviewLimitError,
  BookingReviewRequiredError,
} from '@/lib/bookkeeping/errors'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { isPersonReview, matchBookingOfRows } from '@/lib/booking-review/check'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { debitTotal, unattendedCeilingRefusal } from '@/lib/bookkeeping/unattended-ceiling'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { amountAgreesForMatch } from '@/lib/documents/core-receipt-matcher'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
  type BookingDuplicateExclusions,
  type BookingTarget,
} from '@/lib/transactions/booking-duplicate-detection'
import { runBookingDuplicateGuard, runSkattekontoTaxGuard } from '@/lib/transactions/booking-duplicate-guard'
import {
  isSkattekontoTaxDouble,
  skattekontoTaxDoubleAgentMessage,
  type BookingCounterLine,
} from '@/lib/transactions/skattekonto-tax-double'
import { assertTransactionBookable } from '@/lib/transactions/is-booked'
import { OPEN_INVOICES } from '@/lib/composition/open-invoices'
import { invoiceMatchSide } from '@/lib/transactions/invoice-match-side'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { refuseWhenPairBooked } from '@/lib/operations/inbox-pair-guard'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger, type Logger } from '@/lib/logger'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  InboxChannelContext,
  JournalEntry,
  MappingResult,
  Transaction,
  TransactionCategory,
  VatTreatment,
} from '@/types'
import {
  isReverseChargeBasisAccount,
  REVERSE_CHARGE_TREATMENT_KINDS,
  reverseChargeKindRuta,
  type ReverseChargeKind,
} from '@/lib/bookkeeping/vat-entries'
import { linkBasisColumns } from '@/lib/links/stamp'
import {
  confirmedAbroadRegion,
  purchaseSellerRegion,
  reverseChargeBoxAsk,
  reverseChargeBoxFor,
  FOREIGN_SELLER_VAT_FLAG,
  sellerChargedVat,
  sellerVatOnReverseCharge,
  sellerVatRefusalMessage,
  type ChargedVatReading,
  type ReverseChargeBoxParam,
  type ReverseChargeBoxRefusal,
} from '@/lib/vat/reverse-charge-box'
import { swedishVatNumberAbroad, type SellerIdentity, type SellerRegion } from '@/lib/vat/seller-country'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'

const log = createLogger('transactions/categorize-core')

const ORPHAN_REVERSAL_NOTE =
  'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.'

// ── The service's contract ───────────────────────────────────────────

/**
 * What to book. The fields of CategorizeTransactionSchema (the dashboard and
 * v1 body), plus the three only the agent doors send.
 */
export interface CategorizeInput {
  is_business: boolean
  category?: TransactionCategory
  template_id?: string
  counterparty_template_id?: string
  vat_treatment?: VatTreatment
  /**
   * Basis box of a reverse-charge purchase (ruta 20/21/22). Omitted: read off
   * the underlag at an agent or API door (reverseChargeBoxParam), EU services
   * at the dashboard, whose review shows the box.
   */
  reverse_charge_kind?: ReverseChargeKind
  /** The underlag's actual VAT when it differs from rate × belopp (e.g. dricks). */
  vat_amount?: number
  /** Business-side account replacing the category's (applyAccountOverride). */
  account_override?: string
  /** Bag for the business lines of the verifikat; wins over a learned template bag. */
  dimensions?: Record<string, string>
  user_description?: string
  /** The inbox item the booking started from: matched to the row, then its underlag propagated. */
  inbox_item_id?: string
  /** The suggestion the booking started from, for suggestion_log. */
  proposal_id?: string
  /**
   * The dashboard's word on whether the person saw the booking's review:
   * false for the row's one click, which is booked only when the
   * direct-booking policy lets proposal_id through without a review
   * (oneClickRefusal); true from Granska bokföring. Recorded as
   * suggestion_log.review_shown. Omitted by every other door.
   */
  review_shown?: boolean
  confirm_no_match?: boolean
  force?: boolean
  expected_duplicate_transaction_id?: string
  expected_duplicate_journal_entry_id?: string
  /**
   * Agent doors: book over a detected possible duplicate without naming it
   * (the staged allow_duplicate). The dismissal is recorded all the same.
   */
  allow_duplicate?: boolean
  /**
   * The caller's word that the VAT the underlag shows is foreign VAT the
   * seller charged in error (crm#1765): a reverse charge is then booked on
   * the whole amount paid instead of refused. Never honoured when the
   * document names a Swedish seller (lib/vat/reverse-charge-box.ts).
   */
  confirm_foreign_seller_vat?: boolean
  /** Audit text appended to the verifikat description (agent and bulk doors). */
  notes?: string
}

export interface CategorizeOptions {
  dryRun?: boolean
  /**
   * A row whose pointer names a posted verifikat. The dashboard and v1 doors
   * update its is_business / category flags and leave the verifikat alone
   * (their documented fast path); the approval doors refuse, because an
   * approved booking that books nothing must not read as a success.
   */
  onBooked: 'update_flags' | 'refuse'
  /** Same-batch siblings for the duplicate guard (bulk drivers only). */
  exclude?: BookingDuplicateExclusions
  /** The company's momskoder, shared by a batch so they are read once at most. */
  loadChart?: ChartVatTreatmentsLoader
  /** A batch's one snapshot of what was on offer; omitted, taken before this booking. */
  suggestionSnapshot?: SuggestionSnapshot
  /** Stored on an honoured force (v1 passes 'api_force'). */
  forceVia?: string
  /**
   * The invoice-match intercept (default on). The approval doors turn it off:
   * an agent has no confirm field and matches an open invoice through the
   * match tools, so a staged plain categorization books as staged.
   */
  invoiceMatchIntercept?: boolean
  /**
   * Agent and API doors (#94): a reverse charge sent without
   * reverse_charge_kind reads its box off the underlag's seller and the
   * category, as the bulk doors do (lib/vat/reverse-charge-box.ts), and is
   * refused when that cannot tell it and the booking would carry a basis
   * pair. The value is the door's parameter for the box, named in the
   * refusal. The dashboard leaves it off: its review shows the box it books.
   */
  reverseChargeBoxParam?: ReverseChargeBoxParam
  /**
   * The dashboard's Bokför valda: the person chose reverse_charge_kind for a
   * whole selection, where no review shows an account's own box. It is
   * compared with that box as a named one is (statedReverseChargeBox); no box
   * is read off the underlag.
   */
  reverseChargeBoxChosen?: boolean
  /**
   * The person books without seeing this booking's review (a bulk door).
   * A booking a booking review rule matches is then refused, as for a one
   * click (review_shown false), and the commit is never stamped as reviewed
   * (accounted#130 step 2).
   */
  withoutReview?: boolean
  log?: Logger
}

/** The pinned document's own reading, shown on a preview. */
export interface CategorizeUnderlag {
  document_id: string
  total: number | null
  vat_amount: number | null
  currency: string | null
  /**
   * Whether the document's total is the row's own sum (core-receipt-matcher
   * amountAgreesForMatch): false when it is another sum in the same currency,
   * null when the two cannot be compared (no total, another currency). The
   * underlag is the document the row already holds (transactions.document_id);
   * the booking picks none, so a false here is for whoever stages or approves
   * it to look at before booking (crm#1962).
   */
  matches_row_amount: boolean | null
  /**
   * Set on a reverse charge booked under confirm_foreign_seller_vat: the
   * charge is in the basis and the cost, never deducted. could_be_swedish_vat
   * when it is 25 % of the price, which the document cannot tell from Swedish VAT.
   */
  foreign_seller_vat?: { could_be_swedish_vat: boolean; address_country?: string }
}

export interface CategorizePreview {
  category: TransactionCategory
  mappingResult: MappingResult
  /** The lines the booking posts, in SEK: net cost line, VAT lines, bank line. */
  lines: CreateJournalEntryLineInput[]
  would_create_journal_entry: boolean
  already_had_journal_entry: boolean
  underlag: CategorizeUnderlag | null
  transaction: Transaction
  /** The reverse-charge box booked: the one sent, or the one read off the underlag (reverseChargeBoxParam). */
  reverse_charge_kind?: ReverseChargeKind
}

export interface CategorizeBooked {
  journal_entry_created: boolean
  journal_entry_id: string | null
  category: TransactionCategory
  already_had_journal_entry: boolean
  transaction: Transaction
  /** The guards this booking ran, as its decision records them (lib/suggestion-log/checks.ts). */
  checks: DecisionCheck[]
}

export interface CategorizeRefusal {
  ok: false
  /** A structured-error registry code. */
  code: string
  details?: Record<string, unknown>
  /** Text written for this failure, when it says more than the registry entry. */
  message?: { sv: string; en?: string }
  /** The thrown error behind the refusal, for a door that classifies it itself. */
  cause?: unknown
  /** The row as read, when the refusal came after the read. */
  transaction?: Transaction
}

export type CategorizeOutcome =
  | { ok: true; dryRun: true; preview: CategorizePreview }
  | { ok: true; dryRun: false; booked: CategorizeBooked }
  | CategorizeRefusal

function refuse(
  code: string,
  details?: Record<string, unknown>,
  extra: Pick<CategorizeRefusal, 'message' | 'cause' | 'transaction'> = {},
): CategorizeRefusal {
  return { ok: false, code, ...(details ? { details } : {}), ...extra }
}

/** The category the row is stored with: a template's fallback, the category, or 'private'. */
function resolveFinalCategory(input: Pick<CategorizeInput, 'is_business' | 'category' | 'template_id'>): TransactionCategory {
  if (!input.is_business) return 'private'
  const template = input.template_id ? getTemplateById(input.template_id) : undefined
  if (template) return template.fallback_category
  return input.category || 'uncategorized'
}

// ── Helper: duplicate-guard claim text ───────────────────────────────

/**
 * Swedish two-decimal amount for running prose ("11 500,00"). sv-SE grouping
 * so a raw JS number ("11500.5") never lands inside Swedish text. Magnitude
 * only: direction is the bank line's own, and a minus sign in running Swedish
 * prose reads as a typo.
 */
function formatProseAmount(n: number): string {
  return Math.abs(n).toLocaleString('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * The claim half of the duplicate-guard refusal message: what the candidate
 * verifikat already books on the bank account. Shared by the web/agent
 * categorize refusal below and the MCP `gnubok_categorize_transaction` guard
 * so the two surfaces can never drift (the MCP copy used to print
 * "bokför null kr" for a rateless foreign sibling and misattributed the
 * missing rate to the target row).
 *
 * Three branches:
 *   - `amount === null`: foreign sibling that matched EXACTLY in its own
 *     currency but carries no stored rate. State the match in that currency
 *     rather than fabricating kronor (the match itself is undiminished).
 *   - verified: the candidate's SEK figure, "kr"-labelled. `dup.amount` is
 *     always a SEK figure or null, never the raw foreign number, so "kr" is
 *     correct wherever it prints.
 *   - unverified with a kr figure (ledger-voucher path): the leg's own SEK
 *     amount is real, but no comparison against the TARGET was possible
 *     because the target is foreign without a rate. Say so.
 * A covering samlingsverifikat (issue #101) is not the same movement, so it
 * gets its own claim: what it books on the account and how much of that no
 * transaction is linked to.
 */
export function buildDuplicateBookingClaim(
  dup: Pick<BookedDuplicateCandidate, 'amount' | 'currency' | 'amount_in_currency' | 'amount_verified'> &
    Partial<Pick<BookedDuplicateCandidate, 'covering' | 'account_number'>>,
  transactionCurrency: string | null | undefined,
): string {
  if (dup.covering) {
    return (
      `är ett samlingsverifikat som bokför ${formatProseAmount(dup.covering.booked)} kr på ${dup.account_number ?? 'kontot'} ` +
      `för en period som omfattar transaktionens dag, och ${formatProseAmount(dup.covering.unlinked)} kr av det är inte kopplat till någon transaktion`
    )
  }
  return dup.amount == null
    ? `bokför redan samma belopp (${formatProseAmount(dup.amount_in_currency ?? 0)} ${dup.currency}) på bankkontot, ` +
      `men värdet i kronor kan inte fastställas eftersom växelkurs saknas`
    : dup.amount_verified
      ? `bokför redan ${formatProseAmount(dup.amount)} kr på bankkontot`
      : `bokför ${formatProseAmount(dup.amount)} kr på bankkontot, och beloppen kunde inte jämföras: ` +
        `transaktionen är i ${transactionCurrency} utan växelkurs, så vi kan inte avgöra om det är samma affärshändelse`
}

// ── Helper: ensure a fiscal period covers the date ──────────────────
//
// Moved here from lib/pending-operations/commit.ts so the core is
// self-contained; commit.ts now imports it from this module.

/**
 * More years than this between a date and the last recorded year is a
 * mistyped date, not bookkeeping left undone: BFL keeps seven.
 */
const MAX_CHAINED_FISCAL_YEARS = 10

export async function ensureFiscalPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  date: string,
  fiscalYearStartMonth: number = 1
): Promise<boolean> {
  const { data: existing } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .limit(1)

  if (existing && existing.length > 0) return true

  const { data: recordedRows, error: recordedError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })
  if (recordedError) {
    log.error('Failed to read fiscal periods:', recordedError)
    return false
  }
  const recorded = (recordedRows ?? []) as { id: string; period_start: string; period_end: string }[]

  // Pre-FY guard (issue #1825): a date before the company's first fiscal
  // period must NEVER mint a calendar-year rakenskapsar (a pre-registration
  // year would be legally wrong). Return true and let the pre-FY clamp in
  // createTransactionJournalEntry book the event on the first fiscal year's
  // first day.
  if (recorded.length > 0 && date < recorded[0].period_start) return true

  // A date in a recorded year means that year is closed: nothing to create,
  // the booking meets its lock.
  if (recorded.some((year) => year.period_start <= date && date <= year.period_end)) return true

  // Recorded years decide the next one and fiscal_year_start_month only fills
  // what nothing records. A hole wider than a year fills from its left edge,
  // up to the date: the rest of it stays as it was.
  const years =
    recorded.length > 0
      ? missingFiscalYears(date, recorded, MAX_CHAINED_FISCAL_YEARS)
      : [scheduledFiscalYear(date, fiscalYearStartMonth)]
  if (years.length === 0) {
    log.warn('Date too far past the last fiscal period to chain to', { companyId, date })
    return false
  }

  let previousId = [...recorded].reverse().find((year) => year.period_end < years[0].start)?.id ?? null
  try {
    for (const year of years) {
      previousId = (await insertFiscalYearAfter(supabase, companyId, userId, previousId, year)).id
    }
  } catch (error) {
    // A concurrent booking may have created the year, and the triggers refuse
    // what the law does: the booking then answers from what is there.
    log.error('Failed to create fiscal period:', error)
    return false
  }
  return true
}

// ── The kontering a booking decision maps to ─────────────────────────

/** The company a booking decision is read in, and what it decides before any mapping. */
export interface CategorizeContext {
  entityType: EntityType
  /** Icke momsregistrerad verksamhet books no moms line (lib/bookkeeping/vat-registration.ts). */
  vatRegistered: boolean | null
  fiscalYearStartMonth: number
  template: BookingTemplate | undefined
  finalCategory: TransactionCategory
}

/**
 * The company settings a booking is read in and the template it names,
 * refused when the template is unknown or not for this legal form.
 */
export async function resolveCategorizeContext(
  supabase: SupabaseClient,
  companyId: string,
  input: Pick<CategorizeInput, 'is_business' | 'category' | 'template_id'>,
): Promise<{ ok: true; context: CategorizeContext } | CategorizeRefusal> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type, fiscal_year_start_month, vat_registered')
    .eq('company_id', companyId)
    .single()
  const entityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  // Icke momsregistrerad verksamhet books no moms line on a bank transaction
  // (lib/bookkeeping/vat-registration.ts); the flag is passed as loaded.
  const vatRegistered: boolean | null = settings?.vat_registered ?? null

  const template = input.template_id ? getTemplateById(input.template_id) : undefined
  if (input.template_id) {
    if (!template) {
      return refuse('TX_CATEGORIZE_INVALID_TEMPLATE', { templateId: input.template_id, reason: 'unknown_template' })
    }
    const valid = validateTemplateForEntity(template, entityType)
    if (!valid.valid) {
      return refuse('TX_CATEGORIZE_INVALID_TEMPLATE', { templateId: input.template_id, reason: valid.error })
    }
  }
  const finalCategory = resolveFinalCategory(input)

  return {
    ok: true,
    context: {
      entityType,
      vatRegistered,
      fiscalYearStartMonth: fiscalYearStartMonthFor({ ...settings, entity_type: entityType }),
      template,
      finalCategory,
    },
  }
}

export interface CategorizeMappingOptions {
  log: Logger
  loadChart?: ChartVatTreatmentsLoader
  /**
   * The proposal preview (lib/bookkeeping/proposal-preview.ts): an
   * account_override the chart lacks or has inactive is still placed, since
   * the review activates the person's pick as it books; the booking itself
   * re-checks it.
   */
  preview?: boolean
  /**
   * The box the caller stated for a reverse-charge category booking: named
   * at an agent or API door (reverseChargeBoxParam), or chosen in the app
   * for a whole selection (reverseChargeBoxChosen). A cost account that
   * reports another ruta 20-24 itself is then refused instead of declaring
   * the purchase in its own box. A box read off the underlag is no such
   * statement (the account's own box decides, and the preview says so), nor
   * is the one a single row's review carries: the review names the account's box.
   */
  statedReverseChargeBox?: StatedReverseChargeBox
}

/** See CategorizeMappingOptions.statedReverseChargeBox. */
interface StatedReverseChargeBox {
  kind: ReverseChargeKind
  /** The door's parameter for it; null for the box a person chose in the app. */
  parameter: ReverseChargeBoxParam | null
}

const CONFLICT_CODE = 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT'

/**
 * The refusal of a reverse-charge purchase on a cost account that cannot take
 * it (reverseChargeAccountConflict), in the law's term (omvänd
 * betalningsskyldighet, ML 2023:200 16 kap.). An account that declares a box
 * outside 20-24 is told apart: there the reverse charge itself is wrong, not
 * the account.
 */
function reverseChargeAccountRefusal(
  account: string,
  conflict: ReverseChargeAccountConflict,
  stated: StatedReverseChargeBox | undefined,
): CategorizeRefusal {
  const details = { reason: conflict.reason, account_number: account }
  switch (conflict.reason) {
    case 'other_kind': {
      const own = conflict.box.replace('ruta', '')
      const askedBox = stated ? reverseChargeKindRuta(stated.kind) : null
      const asked = askedBox?.replace('ruta', '') ?? ''
      const named = stated?.parameter
        ? { sv: `${stated.parameter} anger ruta ${asked}`, en: `${stated.parameter} names box ${asked}` }
        : { sv: `den valda rutan är ${asked}`, en: `the box chosen is ${asked}` }
      // A caller can state only rutor 20-22 (REVERSE_CHARGE_TREATMENT_KINDS,
      // the doors' vocabulary). On an account that reports ruta 23 or 24
      // only no box, or the row on its own, gives the account's own.
      const ownCanBeNamed = Object.values(REVERSE_CHARGE_TREATMENT_KINDS)
        .some((kind) => reverseChargeKindRuta(kind) === conflict.box)
      const right = stated?.parameter
        ? {
          sv: `ange ${ownCanBeNamed ? `ruta ${own} eller ` : ''}ingen ruta, så gäller kontots egen`,
          en: `name ${ownCanBeNamed ? `box ${own} or ` : ''}no box, and the account's own applies`,
        }
        : {
          sv: `${ownCanBeNamed ? `välj ruta ${own}, eller ` : ''}bokför raden för sig i granskningen, som visar kontots ruta`,
          en: `${ownCanBeNamed ? `choose box ${own}, or ` : ''}book the row on its own in the review, which shows the account's box`,
        }
      return refuse(CONFLICT_CODE, {
        ...details,
        account_box: conflict.box,
        requested_box: askedBox,
        parameter: stated?.parameter ?? 'reverse_charge_kind',
      }, {
        message: {
          sv: `Konto ${account} redovisar själv ruta ${own}, men ${named.sv}: köpet skulle deklareras i en annan ruta än den angivna. ` +
            `Stämmer kontot, ${right.sv}. Annars bokför köpet på ett vanligt kostnadskonto, där underlagsparet bokför den angivna rutan.`,
          en: `Account ${account} reports box ${own} itself, but ${named.en}: the purchase would be declared in another box than the one named. ` +
            `If the account is right, ${right.en}. Otherwise book the purchase on an ordinary cost account, where the basis pair books the box named.`,
        },
      })
    }
    case 'basis_offset':
      return refuse(CONFLICT_CODE, details, {
        message: {
          sv: `Konto ${account} är motkontot till underlaget för omvänd betalningsskyldighet (ruta 20-24), inte ett kostnadskonto. Bokför köpet på det kostnadskonto som köpet avser.`,
          en: `Account ${account} is the offset of the reverse-charge basis (boxes 20-24), not a cost account. Book the purchase on the cost account it is for.`,
        },
      })
    case 'no_rate':
      return refuse(CONFLICT_CODE, details, {
        message: {
          sv: `Momskoden för omvänd betalningsskyldighet på konto ${account} har ingen momssats på 25, 12 eller 6 % i kontoplanen, så underlaget skulle redovisas utan momssats och köpet deklareras två gånger. ` +
            'Rätta kontots momssats i kontoplanen, eller bokför köpet på ett vanligt kostnadskonto.',
          en: `The reverse-charge momskod of account ${account} has no rate of 25, 12 or 6 % in the chart of accounts, so its basis would be reported without a rate and the purchase declared twice. ` +
            "Correct the account's rate in the chart of accounts, or book the purchase on an ordinary cost account.",
        },
      })
    case 'other_box': {
      const box = conflict.box.replace('ruta', '')
      const message = conflict.box === 'ruta37'
        ? {
          sv: `Konto ${account} redovisar mellanmans inköp vid trepartshandel i ruta 37, utan utgående och ingående moms. Ett sådant köp har ingen omvänd betalningsskyldighet: bokför det utan den, ` +
            'annars deklareras köpet också i ruta 20-24 med moms i ruta 30-32 och 48.',
          en: `Account ${account} reports a middleman's purchase in triangulation (trepartshandel) in box 37, without output or input VAT. Such a purchase carries no reverse charge: book it without one, ` +
            'or the purchase is also declared in boxes 20-24 with VAT in boxes 30-32 and 48.',
        }
        : conflict.box === 'ruta50'
          ? {
            sv: `Konto ${account} är beskattningsunderlaget vid import (ruta 50), och momsen på en import är importmoms i ruta 60-62, inte omvänd betalningsskyldighet. ` +
              'Bokför importen utan omvänd betalningsskyldighet, med importmomsen, annars deklareras köpet också i ruta 20-24 med moms i ruta 30-32.',
            en: `Account ${account} is the taxable amount on import (box 50), and the VAT on an import is import VAT in boxes 60-62, not reverse charge. ` +
              'Book the import without reverse charge, with the import VAT, or the purchase is also declared in boxes 20-24 with VAT in boxes 30-32.',
          }
          : {
            sv: `Konto ${account} redovisar själv ruta ${box}, så köpet skulle också deklareras i ruta 20-24. Bokför det utan omvänd betalningsskyldighet.`,
            en: `Account ${account} reports box ${box} itself, so the purchase would also be declared in boxes 20-24. Book it without reverse charge.`,
          }
      return refuse(CONFLICT_CODE, { ...details, account_box: conflict.box }, { message })
    }
  }
}

/**
 * The kontering a booking decision maps to on this row: the counterparty
 * template, catalog template or category mapping, the underlag's moms, the
 * row's own settlement account, the account override, the reverse-charge
 * basis settled with the chart, the dimensions bag and the counter-leg
 * guard. The booking posts these lines (buildTransactionEntryLines) and the
 * proposal preview shows them, so the two cannot differ.
 */
export async function buildCategorizeMapping(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  input: CategorizeInput,
  context: CategorizeContext,
  options: CategorizeMappingOptions,
): Promise<{ ok: true; mappingResult: MappingResult; settlementAccount: string } | CategorizeRefusal> {
  const isBusiness = input.is_business
  const { template, finalCategory, entityType, vatRegistered } = context

  let mappingResult: MappingResult
  if (input.counterparty_template_id && isBusiness) {
    // Learned codes the registry no longer accepts are dropped on load; an
    // explicit input.dimensions (applied below) is never filtered.
    const match = await loadCounterpartyTemplateMatch(supabase, companyId, input.counterparty_template_id)
    if (!match) {
      return refuse('NOT_FOUND', { resource: 'counterparty_template', id: input.counterparty_template_id })
    }
    mappingResult = buildMappingResultFromCounterpartyTemplate(match, transaction, entityType, vatRegistered)
  } else if (template) {
    // A template that names the skattekonto (1630) books the company's
    // skattekonto account: 2012 for an enskild firma that runs it there.
    const skattekontoAccount = await templateSkattekontoAccountFor(supabase, companyId, template)
    mappingResult = buildMappingResultFromTemplate(template, transaction, entityType, vatRegistered, skattekontoAccount)
    if (input.vat_amount != null) {
      // The underlag's moms replaces the template's rate-based line; the
      // helper refuses a treatment it cannot apply to.
      try {
        mappingResult = applyVatAmountOverride(mappingResult, transaction, template.vat_treatment, input.vat_amount)
      } catch (err) {
        return refuse('TX_CATEGORIZE_INVALID_VAT_AMOUNT', {
          vat_amount: input.vat_amount,
          vat_treatment: template.vat_treatment ?? null,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } else {
    try {
      mappingResult = buildMappingResultFromCategory(
        finalCategory,
        transaction,
        isBusiness,
        entityType,
        input.vat_treatment,
        input.vat_amount,
        vatRegistered,
        input.reverse_charge_kind,
      )
    } catch (err) {
      if (input.vat_amount == null) throw err
      return refuse('TX_CATEGORIZE_INVALID_VAT_AMOUNT', {
        vat_amount: input.vat_amount,
        vat_treatment: input.vat_treatment ?? null,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Book the bank leg against the transaction's ACTUAL settlement account,
  // whichever cash ledger the proposal named (the 1930 placeholder, or the
  // ledger a counterparty template was learned on, crm#1046). The counter leg
  // is never rewritten.
  const settlementAccount = await resolveSettlementAccount(
    supabase,
    companyId,
    transaction.cash_account_id,
    options.log,
    transaction.currency,
  )
  mappingResult = applySettlementAccount(
    mappingResult,
    settlementAccount,
    transaction.amount,
    // A company card's ledger on the bank leg moves like a stale 19xx one;
    // read only when the proposal carries one (load-card-ledgers.ts).
    needsCardLedgers(mappingResult, transaction.amount, settlementAccount)
      ? await loadCardLedgers(supabase, companyId)
      : [],
  )

  // The override replaces the business side of a category booking, never a
  // template's or a learned template's accounts. Re-validated at every
  // booking: the account can be deactivated between staging and approval.
  const categoryBooking = !template && !(input.counterparty_template_id && isBusiness)
  if (input.account_override && categoryBooking) {
    if (!isBusiness) {
      return refuse(
        'VALIDATION_ERROR',
        { field: 'account_override', message: 'account_override cannot be combined with a private marking.' },
        { message: { sv: 'account_override kan inte kombineras med category "private".' } },
      )
    }
    try {
      mappingResult = await applyAccountOverride(
        supabase,
        companyId,
        input.account_override,
        transaction.amount,
        mappingResult,
        // Explicit VAT intent: a stated treatment or an underlag vat_amount.
        // Without it the override books gross (see applyAccountOverride).
        input.vat_treatment != null || input.vat_amount != null,
        { allowUnlisted: options.preview === true },
      )
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (typeof code !== 'string') throw err
      return refuse(code, { accountNumber: input.account_override }, {
        message: { sv: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // A reverse-charge purchase, read on the set the builder booked and the
  // account its cost line lands on (after any account_override), by the
  // company's momskoder. An account that cannot take it is refused, as the
  // utlägg refuses it (reverseChargeAccountConflict): one that declares
  // another box itself, where the basis pair would declare the purchase a
  // second time (import ruta 50 beside ruta 22), and, for a box an agent or
  // API caller named, one whose own ruta 20-24 is another. Otherwise the set
  // keeps its 45xx/4598 basis pair only when the account does not report
  // ruta 20-24 itself (crm#1096, #2919).
  const rcCostAccounts = reverseChargeCostAccounts(mappingResult)
  if (rcCostAccounts) {
    const chart = await (options.loadChart ?? chartVatTreatmentsLoader(supabase, companyId))()
    const stated = categoryBooking ? options.statedReverseChargeBox : undefined
    for (const account of rcCostAccounts) {
      const conflict = reverseChargeAccountConflict(account, chart.get(account), stated?.kind)
      if (conflict) return reverseChargeAccountRefusal(account, conflict, stated)
    }
    mappingResult = reconcileRcBasisWithCostLines(mappingResult, chart)
  }

  // An explicit bag tags the business lines (bank/VAT legs stay untagged); it
  // wins over a learned counterparty-template bag.
  if (input.dimensions && Object.keys(input.dimensions).length > 0) {
    mappingResult.dimensions = input.dimensions
  }

  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return refuse('TX_CATEGORIZE_INVALID_MAPPING', {
      debitAccount: mappingResult.debit_account,
      creditAccount: mappingResult.credit_account,
    })
  }

  // A payment to Skatteverket moves money to the skattekonto and carries no
  // moms (isSkatteverketPayment). This is where the moms is worked out from a
  // treatment, so a category or account picked by mistake ("Resor": 5890 with
  // 25 %) cannot post input VAT on one (crm#1275); the preview refuses the
  // same. A manual multi-line booking (/transactions/[id]/book) states its
  // lines itself and may settle 26xx with the payment, so it is not refused.
  if (isSkatteverketPayment(transaction) && mappingResult.vat_lines.length > 0) {
    return refuse('TX_CATEGORIZE_SKATTEVERKET_VAT', {
      vatAccounts: mappingResult.vat_lines.map((line) => line.account_number),
    })
  }

  // Issue #1643 problem 4: never book the COUNTER leg onto an orphaned
  // cash-account ledger or a twin ledger of the transaction's own bank
  // account. A twin that is merely the stale BANK leg of a learned template
  // is rewritten to the settlement account instead (see guardCounterLegs).
  const guarded = await guardCounterLegs(
    supabase,
    companyId,
    mappingResult,
    settlementAccount,
    transaction.cash_account_id,
  )
  if (guarded.refusedLedger) {
    return refuse('TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT', { accountNumber: guarded.refusedLedger }, {
      message: {
        sv: `Motkontot ${guarded.refusedLedger} är ett bankkonto som hör till transaktionens eget konto eller till en frånkopplad bankanslutning och kan inte användas. Välj ett intäkts- eller kostnadskonto i stället.`,
      },
    })
  }

  // The bank side of the pair (credit for money out, debit for money in) is
  // what the voucher books on the bank account, and commit_journal_entry
  // refuses it unless that is the row's own ledger (guard_bank_booking_context,
  // BANK_BOOKING_SETTLEMENT_CHANGED). settleBankLeg only moves a cash-ledger
  // leg, so a mall or category built for the other direction (D 1630 / K 1930
  // on a deposit) or one that never touches the bank (2440 on the bank side)
  // reached the database as a draft and came back as a bare refusal. Say
  // which account and which side here, in the preview as well, before any draft.
  const bankSide = transaction.amount < 0 ? guarded.mappingResult.credit_account : guarded.mappingResult.debit_account
  if (transaction.amount !== 0 && bankSide !== settlementAccount) {
    const withdrawal = transaction.amount < 0
    return refuse('TRANSACTION_BOOK_BANK_LINE_DIRECTION', {
      settlement_account: settlementAccount,
      required_side: withdrawal ? 'credit' : 'debit',
      booked_account: bankSide,
    }, {
      message: withdrawal
        ? {
          sv: `Transaktionen är ett uttag från bankkontot, så konto ${settlementAccount} ska stå i kredit, men den valda konteringen sätter konto ${bankSide} där. Välj en kategori eller mall som passar ett uttag, eller bokför raden manuellt.`,
          en: `The transaction is a withdrawal from the bank account, so account ${settlementAccount} must be credited, but the chosen booking puts account ${bankSide} there. Choose a category or template that fits a withdrawal, or book the row manually.`,
        }
        : {
          sv: `Transaktionen är en insättning till bankkontot, så konto ${settlementAccount} ska stå i debet, men den valda konteringen sätter konto ${bankSide} där. Välj en kategori eller mall som passar en insättning, eller bokför raden manuellt.`,
          en: `The transaction is a deposit into the bank account, so account ${settlementAccount} must be debited, but the chosen booking puts account ${bankSide} there. Choose a category or template that fits a deposit, or book the row manually.`,
        },
    })
  }
  return { ok: true, mappingResult: guarded.mappingResult, settlementAccount }
}

// ── The service ──────────────────────────────────────────────────────

/**
 * Categorize one bank transaction: resolve the kontering, run every guard,
 * and (unless a dry run) post the verifikat, mark the row booked and carry
 * its underlag onto the verifikat.
 *
 * Refusals are coded results (structured-error registry codes with the
 * details a client branches on); only an unexpected failure throws. Nothing
 * is written before the verifikat is posted except the force/allow_duplicate
 * dismissal record and a missing räkenskapsår (ensureFiscalPeriod), both on
 * a live call only.
 */
/**
 * Why a one click (review_shown false) may not book, or null when it may:
 * the proposal it names must be on offer for the row now, under the
 * company's switch as read with it, and reviewReason
 * (lib/transactions/direct-booking.ts) must let it through. No proposal
 * named, none on offer (the list moved, or the snapshot failed) or no
 * switch read: the review opens, it is never skipped on a guess.
 */
export function oneClickRefusal(
  snapshot: Pick<SuggestionSnapshot, 'byTransaction' | 'directBooking'>,
  txId: string,
  proposalId: string | undefined,
): { proposal_id: string | null; reason: string } | null {
  const proposal = proposalId ? snapshot.byTransaction.get(txId)?.proposals.find((p) => p.template_id === proposalId) : undefined
  if (!proposal || !snapshot.directBooking) return { proposal_id: proposalId ?? null, reason: 'proposal_not_on_offer' }
  const reason = reviewReason(proposal, snapshot.directBooking)
  return reason ? { proposal_id: proposalId ?? null, reason } : null
}

export async function categorizeTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  txId: string,
  input: CategorizeInput,
  options: CategorizeOptions,
): Promise<CategorizeOutcome> {
  const dryRun = options.dryRun === true
  const txLog = (options.log ?? log).child({ transactionId: txId })
  const isBusiness = input.is_business

  // The junction rows ride along on the same read: a row bulk-booked into a
  // samlingsverifikat or split over several verifikat (1:N, #1553) carries
  // journal_entry_id = NULL, and the pointer alone would let it be booked a
  // second time.
  const { data: row, error: fetchError } = await supabase
    .from('transactions')
    .select('*, transaction_voucher_links(journal_entry_id, role)')
    .eq('id', txId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !row) return refuse('TX_CATEGORIZE_TX_NOT_FOUND')
  const { transaction_voucher_links: junctionLinks, ...txRow } = row as Record<string, unknown>
  const transaction = txRow as unknown as Transaction
  const refuseFor = (code: string, details?: Record<string, unknown>, extra: Pick<CategorizeRefusal, 'message' | 'cause'> = {}) =>
    refuse(code, details, { ...extra, transaction })

  // Booked when the pointer or a bank_line link names a posted verifikat
  // (assertTransactionBookable, shared with every booking door). A stale
  // pointer at a reversed verifikat does not count: the row reads as "utan
  // koppling" and must be bookable again (issue #988); the update below uses
  // the observed pointer as its compare-and-set value.
  const bookable = await assertTransactionBookable(supabase, companyId, {
    id: txId,
    journal_entry_id: transaction.journal_entry_id ?? null,
    transaction_voucher_links: Array.isArray(junctionLinks)
      ? (junctionLinks as Array<{ journal_entry_id: string; role?: string | null }>)
      : [],
  })
  // The guards this booking runs, in order, for its decision record.
  const checks: DecisionCheck[] = []
  let wouldBook = true
  if (!bookable.ok) {
    const flagsOnly = options.onBooked === 'update_flags' && bookable.via === 'pointer'
    if (!flagsOnly) {
      return refuseFor(bookable.code, { journal_entry_id: bookable.journalEntryId, via: bookable.via })
    }
    if (!dryRun) return updateFlagsOnly(supabase, companyId, transaction, input)
    // A dry run on a booked row previews the kontering a fresh row would get.
    wouldBook = false
  } else {
    checks.push(passed('already_booked'))
  }

  // A one click is booked only when the policy lets that proposal through
  // without a review, judged here on what is on offer now, before any guard
  // writes anything. The snapshot is the one the decision is recorded with.
  let suggestionSnapshot = options.suggestionSnapshot
  if (wouldBook && !dryRun && input.review_shown === false) {
    suggestionSnapshot ??= await snapshotSuggestions(supabase, companyId, [txId])
    const refusal = oneClickRefusal(suggestionSnapshot, txId, input.proposal_id)
    if (refusal) return refuseFor('TX_CATEGORIZE_REVIEW_REQUIRED', refusal)
  }

  const target: BookingTarget = {
    id: txId,
    date: transaction.date,
    amount: transaction.amount,
    // `amount` is denominated in `currency`; the ledger legs the guard
    // compares it against are always SEK.
    currency: transaction.currency ?? null,
    amount_sek: transaction.amount_sek ?? null,
    exchange_rate: transaction.exchange_rate ?? null,
    cash_account_id: transaction.cash_account_id ?? null,
    // The row's provider identity: two entries of one feed the ids tell
    // apart are never twins (crm#1271, crm#1312).
    external_id: transaction.external_id ?? null,
    import_source: transaction.import_source ?? null,
    bank_connection_id: transaction.bank_connection_id ?? null,
    provider_transaction_id: transaction.provider_transaction_id ?? null,
    bank_file_import_id: transaction.bank_file_import_id ?? null,
  }

  // Booking-time duplicate guard: refuse a second verifikat for an
  // affärshändelse the ledger already books (TRANSACTION_BOOK_POSSIBLE
  // _DUPLICATE). `force` bound to the reviewed candidate books anyway; the
  // agent doors' allow_duplicate does too without naming it. Either bypass
  // leaves a behandlingshistorik record on a live call (BFNAR 2013:2 p. 9.16).
  // The skattekonto half needs the kontering and runs after the mapping
  // below; a force naming its candidate is bound there (deferredForce).
  let deferredForce: string | null = null
  let forcedOverBankCandidate = false
  if (wouldBook) {
    if (input.allow_duplicate === true) {
      if (!dryRun) checks.push(duplicateCheck(await recordAllowedDuplicate(supabase, companyId, userId, target, options.exclude, txLog)))
    } else {
      const verdict = await runBookingDuplicateGuard(supabase, companyId, userId, target, input, txLog, {
        exclude: options.exclude,
        recordDismissal: !dryRun,
        via: options.forceVia,
        deferForceToSkattekonto: true,
      })
      if (!verdict.ok) return refuseFor(verdict.code, verdict.details as Record<string, unknown>)
      if (verdict.deferredForce) deferredForce = verdict.deferredForce
      else checks.push(duplicateCheck(verdict.verdict))
      forcedOverBankCandidate = verdict.verdict.kind === 'forced'
    }
  }

  const resolved = await resolveCategorizeContext(supabase, companyId, input)
  if (!resolved.ok) return { ...resolved, transaction }
  const { context } = resolved
  const { finalCategory } = context

  // The underlag's own reading (categorizeUnderlagDocuments): shown on a
  // preview, and the check on a reverse charge asked for on an invoice where
  // the seller charged moms, for every document the booking anchors.
  // Refused by default, since Swedish moms on an invoice is ordinary ingående
  // moms. Booked when the caller states the charge is foreign VAT debited in
  // error (crm#1765): the buyer is still liable (ML 16 kap. 9 §) on all the
  // seller was paid, which is the bank row's amount the mapping below already
  // takes as cost and basis, and no line deducts the seller's VAT (vat_amount
  // is refused with reverse_charge). A document naming a Swedish seller is
  // refused whatever is stated.
  let underlag: CategorizeUnderlag | null = null
  let documentSeller: SellerIdentity | null = null
  const underlagDocuments = await categorizeUnderlagDocuments(supabase, companyId, transaction, input, dryRun)
  const [doc] = underlagDocuments
  if (doc) {
    const ex = doc.reading
    documentSeller = ex?.supplier ?? null
    const total = ex?.totals?.total ?? null
    const currency = ex?.invoice?.currency ?? null
    const rowCurrency = transaction.currency ?? 'SEK'
    underlag = {
      document_id: doc.id,
      total,
      vat_amount: ex?.totals?.vatAmount ?? null,
      currency,
      matches_row_amount: amountAgreesForMatch(total, currency ?? 'SEK', null, transaction.amount, rowCurrency, transaction.amount),
    }
  }
  if (underlag && input.vat_treatment === 'reverse_charge') {
    let confirmed: { could_be_swedish_vat: boolean; address_country?: string } | null = null
    for (const one of underlagDocuments) {
      // The charge as the bulk door and the one click read it: the breakdown's groups, else the total's VAT.
      const charged = sellerChargedVat(one.reading)
      const sellerVat = sellerVatOnReverseCharge({
        sellerVat: charged,
        total: one.reading?.totals?.total ?? null,
        seller: one.reading?.supplier ?? null,
        confirmedForeign: input.confirm_foreign_seller_vat === true,
      })
      if (sellerVat.verdict === 'refused') {
        const currency = one.reading?.invoice?.currency ?? null
        return refuseFor(
          'TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT',
          {
            document_id: one.id,
            seller_vat_amount: charged,
            currency,
            reason: sellerVat.reason,
            ...(sellerVat.reason === 'not_confirmed' ? { confirm_with: FOREIGN_SELLER_VAT_FLAG } : {}),
            ...(sellerVat.reason === 'not_confirmed' && sellerVat.addressCountry ? { address_country: sellerVat.addressCountry } : {}),
          },
          {
            message: sellerVatRefusalMessage(
              sellerVat.reason,
              [charged, currency].filter(Boolean).join(' '),
              sellerVat.reason === 'not_confirmed' ? sellerVat.addressCountry : null,
            ),
          },
        )
      }
      if (sellerVat.verdict === 'confirmed') {
        // A Swedish VAT number beside an address abroad: the approver reads what was stated.
        const addressCountry = confirmed?.address_country ?? swedishVatNumberAbroad(one.reading?.supplier)
        confirmed = {
          could_be_swedish_vat: (confirmed?.could_be_swedish_vat ?? false) || sellerVat.couldBeSwedishVat,
          ...(addressCountry ? { address_country: addressCountry } : {}),
        }
      }
    }
    if (confirmed) {
      underlag.foreign_seller_vat = confirmed
      checks.push(warned('reverse_charge_seller_vat', FOREIGN_SELLER_VAT_FLAG))
    } else {
      checks.push(passed('reverse_charge_seller_vat'))
    }
  }

  // The box the caller stated (named at an agent or API door, chosen in the
  // app for a selection): checked against a cost account that reports its
  // own (buildCategorizeMapping). One read off the underlag below is not
  // checked, the account's own box decides.
  const statedReverseChargeBox = input.reverse_charge_kind && (options.reverseChargeBoxParam || options.reverseChargeBoxChosen)
    ? { kind: input.reverse_charge_kind, parameter: options.reverseChargeBoxParam ?? null }
    : undefined
  // A reverse charge without its box, at an agent or API door (#94): the box
  // its underlag's seller and the category give, never ruta 21 by default.
  // Read only for a category booking: a template states its own lines.
  let boxUnknown: ReverseChargeBoxRefusal | null = null
  if (
    options.reverseChargeBoxParam &&
    input.vat_treatment === 'reverse_charge' &&
    !input.reverse_charge_kind &&
    isBusiness &&
    !context.template &&
    !input.counterparty_template_id &&
    finalCategory.startsWith('expense_')
  ) {
    // A Swedish VAT number beside an address abroad, confirmed as a seller not established here: the address's
    // country, for a service.
    const region =
      purchaseSellerRegion(documentSeller) ??
      (input.confirm_foreign_seller_vat === true ? confirmedAbroadRegion(documentSeller, finalCategory) : null) ??
      (input.inbox_item_id ? await inboxItemSellerRegionById(supabase, companyId, input.inbox_item_id) : null)
    const box = reverseChargeBoxFor(region, finalCategory)
    if (box.ok) input = { ...input, reverse_charge_kind: box.kind }
    else boxUnknown = box.reason
  }

  const mapped = await buildCategorizeMapping(supabase, companyId, transaction, input, context, {
    log: txLog,
    loadChart: options.loadChart,
    statedReverseChargeBox,
  })
  if (!mapped.ok) return { ...mapped, transaction }
  const { mappingResult, settlementAccount } = mapped
  // A feed row (Stripe) on a day a samlingsverifikat or the migrated ledger
  // already holds is the same money a second time (accounted#101): link it to
  // that verifikat or ignore it. Bank rows are never read for. The refusal
  // names the day and what holds it (crm#1901).
  if (wouldBook) {
    const covered = await coveredFeedRows(supabase, companyId, [transaction], () => settlementAccount)
    if (covered.length > 0) {
      const { transaction_ids: _row, ...coverage } = covered[0]!
      return refuseFor('TX_CATEGORIZE_LEDGER_DAY_COVERED', coverage, { message: coveredDayMessage(covered, 1) })
    }
  }

  // The default would decide the box only where a basis pair is booked: a
  // cost account whose momskod reports ruta 20-24, or an override onto a
  // basis account, decides it itself (crm#1096).
  if (boxUnknown && mappingResult.vat_lines.some((l) => l.debit_amount > 0 && isReverseChargeBasisAccount(l.account_number))) {
    return refuseFor(
      'TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN',
      { reason: boxUnknown, parameter: options.reverseChargeBoxParam },
      { message: reverseChargeBoxAsk(boxUnknown, options.reverseChargeBoxParam!) },
    )
  }
  // The mapping returns only after guardCounterLegs let its legs through.
  checks.push(passed('counter_legs'))

  // Every account the verifikat posts to must be in the chart or seedable
  // from BAS: a missing one would otherwise make the engine throw mid-flight.
  const missingAccounts = await findUnresolvableAccounts(
    supabase,
    companyId,
    collectMappingResultAccounts(mappingResult),
  )
  if (missingAccounts.length > 0) {
    txLog.warn('mapping references inactive/unknown accounts', { missingAccounts })
    return refuseFor('ACCOUNTS_NOT_IN_CHART', { account_numbers: missingAccounts }, {
      message: { sv: `Följande konton behöver aktiveras: ${missingAccounts.join(', ')}` },
    })
  }
  checks.push(passed('chart'))

  // Hard blocks (accounted#130 step 2): a booking a booking review rule
  // matches is booked only by a person from its review. A key, an agent,
  // cron, and a person's one click or bulk booking are refused here, before
  // anything more is written; commit_journal_entry holds the same line for
  // whatever gets past. A dry run previews it: staging is how an agent
  // hands such a booking to a person.
  // Without an actor scope (a server action, a test) the database decides alone.
  const reviewSkipped = input.review_shown === false || options.withoutReview === true
  const bookingActor = getActor()
  if (wouldBook && !dryRun && (reviewSkipped || (bookingActor && !isPersonReview(bookingActor)))) {
    let lines: CreateJournalEntryLineInput[] | null = null
    try {
      lines = buildTransactionEntryLines(transaction, mappingResult)
    } catch {
      // The engine refuses the same booking below, with its own code.
    }
    const matched = lines ? await matchBookingOfRows(supabase, companyId, [transaction], lines) : []
    if (matched.length > 0) {
      return bookingActor?.type === 'user'
        ? refuseFor('TX_CATEGORIZE_REVIEW_REQUIRED', { proposal_id: input.proposal_id ?? null, reason: 'booking_blocked', matched_rules: matched })
        : refuseFor('BOOKING_REVIEW_REQUIRED', { transaction_id: txId, matched_rules: matched })
    }
  }

  // The booking guard's skattekonto half (issue #50): a tax account booked
  // straight from the bank when the skattekonto booked the same tax this
  // month. It judges the kontering, so it runs here; a force already bound
  // to a bank-line candidate covers the booking.
  if (wouldBook && !forcedOverBankCandidate) {
    const tax = await runSkattekontoTaxGuard(
      supabase,
      companyId,
      userId,
      { ...target, counter_lines: konteringLines(transaction, mappingResult) },
      input,
      txLog,
      { deferredForce, exclude: options.exclude, recordDismissal: !dryRun, via: options.forceVia },
    )
    if (!tax.ok) return refuseFor(tax.code, tax.details as Record<string, unknown>)
    if (tax.verdict) {
      // One duplicate check per booking: this verdict replaces the bank-line
      // halves' allow_duplicate record, or is the deferred force's.
      const at = checks.findIndex((c) => c.id === 'duplicate')
      if (at >= 0) checks[at] = duplicateCheck(tax.verdict)
      else checks.push(duplicateCheck(tax.verdict))
    }
  }

  // Invoice-match intercept: a plain 244x / 151x categorization an open
  // supplier / customer invoice covers is refused with the candidates, so the
  // payment is matched instead of booked twice; confirm_no_match keeps it.
  if (wouldBook && options.invoiceMatchIntercept !== false) {
    const invoiceSuggestion = await OPEN_INVOICES.findCategorizeInterception(
      supabase,
      companyId,
      {
        transaction: transaction as Transaction & { reference?: string | null },
        debitAccount: mappingResult.debit_account,
        creditAccount: mappingResult.credit_account,
        isBusiness,
        confirmNoMatch: input.confirm_no_match,
      },
      txLog,
    )
    if (invoiceSuggestion) {
      return refuseFor(invoiceSuggestion.code, invoiceSuggestion.details as Record<string, unknown>)
    }
    // Recorded only where the intercept applies: a 5410 booking has no invoice to match.
    const side = invoiceMatchSide({
      transaction,
      debitAccount: mappingResult.debit_account,
      creditAccount: mappingResult.credit_account,
      isBusiness,
    })
    if (side) checks.push(input.confirm_no_match ? warned('invoice_match', 'confirm_no_match') : passed('invoice_match', side))
  }

  if (wouldBook) {
    // Issue #1661: a private marking books eget uttag/insättning, so a locked
    // period refuses it like any verifikat; its code names the ignore path,
    // since the row is usually no affärshändelse at all.
    const periodLock = await checkPeriodLock(supabase, companyId, transaction.date)
    if (periodLock.locked) {
      return refuseFor(isBusiness ? 'PERIOD_LOCKED' : 'TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED', {
        transaction_date: transaction.date,
        reason: periodLock.reason,
        fiscal_period_id: periodLock.fiscal_period_id,
        ...(isBusiness ? {} : { suggested_action: 'ignore' }),
      })
    }
    // After the lock: a refused booking leaves no year behind, and a date
    // without a year is still judged by the company's lock date.
    if (!dryRun) {
      await ensureFiscalPeriod(supabase, userId, companyId, transaction.date, context.fiscalYearStartMonth)
    }
    checks.push(passed('period_lock'))
  }

  if (dryRun) {
    let lines: CreateJournalEntryLineInput[]
    try {
      lines = buildTransactionEntryLines(transaction, mappingResult)
    } catch (err) {
      if (err instanceof TransactionMissingSekValueError) return missingSekRefusal(err, transaction)
      if (err instanceof TransactionLinesNotBalancedError) return linesNotBalancedRefusal(err, transaction, input)
      throw err
    }
    // An API key's unattended ceiling, which the booking's commit asks: the
    // preview answers what the booking would.
    const overCeiling = wouldBook ? unattendedCeilingRefusal(debitTotal(lines)) : null
    if (overCeiling) {
      return refuseFor(overCeiling.code, { attempted: overCeiling.attempted, limit: overCeiling.limit }, { cause: overCeiling })
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        category: finalCategory,
        mappingResult,
        lines,
        would_create_journal_entry: wouldBook,
        already_had_journal_entry: !wouldBook,
        underlag,
        transaction,
        ...(input.reverse_charge_kind ? { reverse_charge_kind: input.reverse_charge_kind } : {}),
      },
    }
  }

  // What was on offer, taken before the booking and its learning.
  suggestionSnapshot ??= await snapshotSuggestions(supabase, companyId, [txId])
  let bookedEntry: JournalEntry | null
  // A booking the person did not review is never stamped as reviewed.
  const asBooked = <T>(fn: () => Promise<T>): Promise<T> =>
    reviewSkipped && bookingActor ? runWithActor({ ...bookingActor, withoutReview: true }, fn) : fn()
  try {
    bookedEntry = await asBooked(() => createTransactionJournalEntry(supabase, companyId, userId, transaction, mappingResult, input.notes, {
      // The voucher carries the rules its decision was made under.
      rubricVersion: suggestionSnapshot.ruleVersion,
      // The business event (posting port pilot; read only while
      // POSTING_EVENTS is shadow or strict): the kontering's source follows
      // buildCategorizeMapping's own order.
      businessEvent: {
        category: finalCategory,
        source: input.counterparty_template_id && isBusiness ? 'counterpartyTemplate' : context.template ? 'bookingTemplate' : 'category',
        vatTreatment: input.vat_treatment ?? context.template?.vat_treatment ?? null,
        // The basis the row is stamped with below, resolved in the same scope.
        linkBasis: linkBasisColumns('user_created'),
        inboxItemId: input.inbox_item_id ?? null,
        proposalId: input.proposal_id ?? null,
        templateId: context.template?.id ?? null,
        counterpartyTemplateId: isBusiness ? (input.counterparty_template_id ?? null) : null,
      },
    }))
  } catch (err) {
    // An account deactivated between the check above and the engine call.
    if (err instanceof AccountsNotInChartError) {
      return refuseFor('ACCOUNTS_NOT_IN_CHART', { account_numbers: err.accountNumbers }, {
        message: { sv: `Följande konton behöver aktiveras: ${err.accountNumbers.join(', ')}` },
        cause: err,
      })
    }
    if (err instanceof TransactionMissingSekValueError) return missingSekRefusal(err, transaction)
    // The built lines do not balance: refused before any draft, nothing posted.
    if (err instanceof TransactionLinesNotBalancedError) return linesNotBalancedRefusal(err, transaction, input)
    // Above the API key's unattended ceiling: nothing was posted and the row
    // stays in "Att bokföra" for a person, under the refusal's own code.
    if (err instanceof UnattendedCommitLimitExceededError) {
      return refuseFor(err.code, { attempted: err.attempted, limit: err.limit }, { cause: err })
    }
    // A booking review rule matched in the database (accounted#130): nothing
    // was posted. A person's one click opens the review; anyone else stages.
    if (err instanceof BookingReviewRequiredError) {
      return bookingActor?.type === 'user'
        ? refuseFor('TX_CATEGORIZE_REVIEW_REQUIRED', { proposal_id: input.proposal_id ?? null, reason: 'booking_blocked' }, { cause: err })
        : refuseFor(err.code, { transaction_id: txId }, { cause: err })
    }
    if (err instanceof BookingReviewLimitError) {
      return refuseFor(err.code, { amount_sek: err.amountSek, limit_sek: err.limitSek }, { cause: err })
    }
    // Fail closed (issue #1947): the verifikat IS the booking, so nothing is
    // written and the row stays in "Att bokföra".
    // A named database refusal (PT409: the bank row changed, another bank
    // change holds the lock) is answered as a 409 the person can act on:
    // warn. Anything else is a failure of ours.
    const causeCode = getStructuredError(err).code
    if (getErrorEntry(causeCode)?.httpStatus === 409) {
      txLog.warn('journal entry creation failed', err as Error)
    } else {
      txLog.error('journal entry creation failed', err as Error)
    }
    const sv = getErrorMessage(err, { context: 'transaction' })
    return refuseFor('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED', { cause: causeCode, message: sv }, {
      message: { sv, en: getErrorMessage(err, { context: 'transaction', locale: 'en' }) },
      cause: err,
    })
  }

  // createTransactionJournalEntry returns null WITHOUT throwing when no OPEN
  // period covers the date and the pre-FY clamp does not apply: no
  // räkenskapsår there at all, or a closed one. checkPeriodLock tells the two
  // apart for an honest code.
  if (!bookedEntry) {
    const verdict = await checkPeriodLock(supabase, companyId, transaction.date)
    if (verdict.locked) {
      return refuseFor(isBusiness ? 'PERIOD_LOCKED' : 'TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED', {
        transaction_date: transaction.date,
        reason: verdict.reason,
        fiscal_period_id: verdict.fiscal_period_id,
        ...(isBusiness ? {} : { suggested_action: 'ignore' }),
      })
    }
    return refuseFor('NO_OPEN_PERIOD_FOR_DATE', { transaction_date: transaction.date, reason: 'no_fiscal_period' })
  }

  await recordDecisions(supabase, suggestionSnapshot, [{
    transactionId: txId,
    actedOn: input.proposal_id ?? null,
    // Only the dashboard says; every other door leaves review_shown null.
    ...(input.review_shown !== undefined ? { reviewShown: input.review_shown } : {}),
    final: finalFromCategorize({
      journalEntry: bookedEntry,
      mappingResult,
      amount: transaction.amount,
      templateId: input.template_id ?? null,
      counterpartyTemplateId: input.counterparty_template_id ?? null,
      category: isBusiness ? (input.category ?? finalCategory) : 'private',
      vatTreatment: input.vat_treatment ?? null,
    }),
    checks,
  }], userId)

  // Compare-and-set on the pointer as read: a concurrent booking of the same
  // row must not be overwritten. A stale pointer at a reversed verifikat is
  // replaced only if nobody changed it meanwhile.
  const linkTransaction = async () => {
    const updateQuery = supabase
      .from('transactions')
      .update({
        is_business: isBusiness,
        category: finalCategory,
        is_ignored: false,
        journal_entry_id: bookedEntry.id,
        // The verifikat was booked from this bank line. The request scope says
        // who: a person, an approval of an agent's proposal, or a client.
        ...linkBasisColumns('user_created'),
      })
      .eq('id', txId)
      .eq('company_id', companyId)
    const guardedUpdate = transaction.journal_entry_id
      ? updateQuery.eq('journal_entry_id', transaction.journal_entry_id)
      : updateQuery.is('journal_entry_id', null)
    return await guardedUpdate.select('*')
  }
  // The link's guard refuses with CASH_ACCOUNT_OPERATION_BUSY while another
  // booking of the company is being numbered (cash-account-busy.ts). Nothing
  // was written then and the verifikat is already posted, so the link is
  // tried again before the verifikat is given up: giving it up costs a storno,
  // and a storno that hits the same lock left the verifikat posted beside an
  // unbooked row that was then booked a second time.
  const { data: updated, error: updateError } = await retryWhileCashAccountBusy(
    linkTransaction,
    (outcome) => isCashAccountBusy(outcome.error),
  )
  if (updateError || !updated || updated.length === 0) {
    await reverseOrphanedJournalEntry(supabase, companyId, userId, bookedEntry.id, ORPHAN_REVERSAL_NOTE)
    if (updateError) {
      // Still busy after the retries: the retryable 409 the person can act
      // on ("vänta en stund och försök igen"), not a failure of ours.
      if (isCashAccountBusy(updateError)) {
        txLog.warn('failed to update transaction: bank accounts busy', updateError)
        return refuseFor('CASH_ACCOUNT_OPERATION_BUSY', undefined, { cause: updateError })
      }
      txLog.error('failed to update transaction', updateError)
      return refuseFor(
        getStructuredError(updateError).code === 'TX_CATEGORIZE_IGNORED_CONFLICT' ? 'TX_CATEGORIZE_IGNORED_CONFLICT' : 'INTERNAL_ERROR',
        undefined,
        { cause: updateError },
      )
    }
    return refuseFor('TX_CATEGORIZE_RACE')
  }
  const updatedTransaction = updated[0] as Transaction

  // The inbox item the booking started from joins the row's matched items, so
  // the propagation below anchors its underlag and stamps it booked. An item
  // another verifikat or a supplier invoice already consumed is left alone.
  if (input.inbox_item_id) {
    const { error: matchError } = await supabase
      .from('invoice_inbox_items')
      .update({ matched_transaction_id: txId })
      .eq('id', input.inbox_item_id)
      .eq('company_id', companyId)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
    if (matchError) txLog.warn('failed to match the inbox item to the booked row (non-critical)', matchError)
  }

  // Anchor the row's pinned document and the matched inbox items' underlag on
  // the new verifikat (BFL 7 kap). Best-effort by contract: the verifikat is
  // posted, and re-running the step repairs a failed link.
  await propagateUnderlagForBookedTransaction(supabase, companyId, txId, bookedEntry.id)

  // Learning runs only after the booking won its write, so it never learns
  // from a booking that did not happen. direction_mismatch = a mirrored
  // refund/repayment booking; learning it would store backwards accounts.
  if (isBusiness && transaction.merchant_name && !mappingResult.direction_mismatch) {
    try {
      // A card row teaches the 1930 placeholder, never its card ledger, so the
      // rule replays on a bank row too (bank-leg.ts learnableBankPair).
      const learned = learnableBankPair(mappingResult, transaction.amount)
      await saveUserMappingRule(
        supabase,
        companyId,
        transaction.merchant_name,
        learned.debit_account,
        learned.credit_account,
        !isBusiness,
        input.user_description,
        input.template_id,
      )
    } catch (err) {
      txLog.warn('failed to save mapping rule (non-critical)', err as Error)
    }
  }
  try {
    // Booked on a counterpart template: a text it does not carry yet becomes
    // its alias instead of a second template (accounted#36).
    await upsertCounterpartyTemplate(supabase, companyId, transaction, mappingResult, 'user_approved', {
      bookedOnTemplateId: isBusiness ? input.counterparty_template_id : undefined,
    })
  } catch (err) {
    txLog.warn('failed to upsert counterparty template (non-critical)', err as Error)
  }

  try {
    await eventBus.emit({
      type: 'transaction.categorized',
      payload: {
        transaction: updatedTransaction,
        account: mappingResult.debit_account,
        taxCode: mappingResult.vat_lines[0]?.account_number || '',
        userId,
        companyId,
      },
    })
  } catch (err) {
    txLog.warn('transaction.categorized emit failed (non-critical)', err as Error)
  }

  return {
    ok: true,
    dryRun: false,
    booked: {
      journal_entry_created: true,
      journal_entry_id: bookedEntry.id,
      category: finalCategory,
      already_had_journal_entry: false,
      transaction: updatedTransaction,
      checks,
    },
  }
}

/**
 * The documented fast path for a row a posted verifikat already books: set
 * its flags, leave the verifikat alone (immutable once posted, BFL 5 kap).
 */
async function updateFlagsOnly(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  input: CategorizeInput,
): Promise<CategorizeOutcome> {
  const category = resolveFinalCategory(input)
  const { error } = await supabase
    .from('transactions')
    .update({ is_business: input.is_business, category, is_ignored: false })
    .eq('id', transaction.id)
    .eq('company_id', companyId)
  if (error) {
    return refuse(
      getStructuredError(error).code === 'TX_CATEGORIZE_IGNORED_CONFLICT' ? 'TX_CATEGORIZE_IGNORED_CONFLICT' : 'INTERNAL_ERROR',
      undefined,
      { cause: error, transaction },
    )
  }
  return {
    ok: true,
    dryRun: false,
    booked: {
      journal_entry_created: false,
      journal_entry_id: transaction.journal_entry_id ?? null,
      category,
      already_had_journal_entry: true,
      transaction,
      // Nothing was booked, so no booking guard ran.
      checks: [],
    },
  }
}

function missingSekRefusal(err: TransactionMissingSekValueError, transaction: Transaction): CategorizeRefusal {
  log.warn('categorize refused: foreign transaction has no SEK value', {
    txId: transaction.id,
    currency: err.currency,
  })
  return refuse(err.code, { currency: err.currency, transaction_date: err.date }, { cause: err, transaction })
}

/**
 * The refusal for a kontering whose lines do not balance on this row
 * (TransactionLinesNotBalancedError, thrown where the lines are built): a 400
 * that names the two totals and what to do instead, where the engine's own
 * refusal used to come back as a failed booking. Exported for the proposal
 * preview, which answers what the booking would.
 */
export function linesNotBalancedRefusal(
  err: TransactionLinesNotBalancedError,
  transaction: Transaction,
  input: Pick<CategorizeInput, 'counterparty_template_id' | 'template_id' | 'category'>,
): CategorizeRefusal {
  // Warn, with what it takes to find the kontering: the person is told what
  // to do, and a learned pattern that cannot be replayed is ours to look at.
  log.warn('categorize refused: built lines do not balance', {
    txId: transaction.id,
    totalDebit: err.totalDebit,
    totalCredit: err.totalCredit,
    fromLinePattern: err.fromLinePattern,
    counterpartyTemplateId: input.counterparty_template_id ?? null,
    templateId: input.template_id ?? null,
    category: input.category ?? null,
    currency: transaction.currency,
  })
  const debit = formatProseAmount(err.totalDebit)
  const credit = formatProseAmount(err.totalCredit)
  const message = err.fromLinePattern
    ? {
      sv: `Den inlärda konteringen för motparten passar inte den här transaktionen: raderna ger ${debit} kr i debet och ${credit} kr i kredit och går inte ihop. Inget är bokfört. Välj en kategori eller ett konto i stället, eller bokför raden manuellt.`,
      en: `The learned booking for this counterparty does not fit this transaction: its lines give ${debit} kr in debit and ${credit} kr in credit and do not balance. Nothing was booked. Pick a category or an account instead, or book the row manually.`,
    }
    : {
      sv: `Konteringen går inte ihop för den här transaktionen: raderna ger ${debit} kr i debet och ${credit} kr i kredit. Inget är bokfört. Välj en annan kategori eller mall, eller bokför raden manuellt.`,
      en: `The booking does not balance for this transaction: its lines give ${debit} kr in debit and ${credit} kr in credit. Nothing was booked. Pick another category or template, or book the row manually.`,
    }
  return refuse(
    err.code,
    {
      total_debit: err.totalDebit,
      total_credit: err.totalCredit,
      from_line_pattern: err.fromLinePattern,
      ...(input.counterparty_template_id ? { counterparty_template_id: input.counterparty_template_id } : {}),
    },
    { message, cause: err, transaction },
  )
}

/**
 * The lines the booking would post, ledger sign, for the guard's skattekonto
 * half. Undefined when they cannot be built (a foreign row with no SEK
 * value: the booking itself refuses that later), which leaves the half out.
 */
function konteringLines(transaction: Transaction, mappingResult: MappingResult): BookingCounterLine[] | undefined {
  try {
    return buildTransactionEntryLines(transaction, mappingResult).map((line) => ({
      account_number: line.account_number,
      // Netted to the öre by the guard (directTaxCounterLines).
      net: Number(line.debit_amount || 0) - Number(line.credit_amount || 0),
    }))
  } catch {
    // The booking itself refuses an unbuildable row later; the guard's
    // skattekonto half is simply left out here.
    return undefined
  }
}

/**
 * allow_duplicate bypassed the guard without naming the candidate. Booking
 * over a possible double-booking still has to leave a durable
 * behandlingshistorik record (BFNAR 2013:2 p. 9.16): re-detect to capture the
 * dismissed candidate. Best-effort: a logging failure never blocks a booking.
 */
async function recordAllowedDuplicate(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  target: BookingTarget,
  exclude: BookingDuplicateExclusions | undefined,
  txLog: Logger,
): Promise<DuplicateVerdict> {
  let dismissed: BookedDuplicateCandidate | null
  try {
    dismissed = await detectBookingDuplicate(supabase, companyId, target, exclude)
  } catch (err) {
    txLog.warn('duplicate detection for the allow_duplicate record failed', err as Error)
    return { kind: 'detection_failed' }
  }
  if (!dismissed) return { kind: 'allowed_none' }
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: target.id,
      aggregateType: 'BankTransaction',
      aggregateId: target.id,
      eventType: 'BankTransactionDuplicateDismissed',
      payload: {
        transaction_id: target.id,
        dismissed_transaction_id: dismissed.transaction_id,
        dismissed_journal_entry_id: dismissed.journal_entry_id,
        // Null when the candidate's SEK value could not be established (a
        // rateless foreign sibling); the foreign figures then carry the record.
        amount_ore: dismissed.amount != null ? Math.round(dismissed.amount * 100) : null,
        dismissed_currency: dismissed.currency,
        dismissed_amount_in_currency: dismissed.amount_in_currency,
        entry_date: dismissed.entry_date,
        // Whether a confirmed same-amount twin or a never-comparable candidate
        // was dismissed: the record has to say which (BFNAR 2013:2 p. 9.16).
        amount_verified: dismissed.amount_verified,
        unverified_reason: dismissed.unverified_reason,
        via: 'allow_duplicate',
      },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (logErr) {
    txLog.warn('failed to record duplicate-dismissal behandlingshistorik', logErr as Error)
  }
  return { kind: 'allowed', journal_entry_id: dismissed.journal_entry_id ?? null, transaction_id: dismissed.transaction_id ?? null }
}

// ── The approval doors' result shape ─────────────────────────────────

/** Structurally compatible with the commit.ts `ExecutorResult`. */
export interface CategorizeCoreResult {
  data?: Record<string, unknown>
  error?: string
  /**
   * Structured-error registry code for `error`. commit.ts surfaces it as
   * CommitResult.code and persists it in result_data.error_code so approvers
   * can branch on the failure mode.
   */
  errorCode?: string
  status?: number
  /** On a booking: the guards it ran (never persisted in result_data; the bulk-inbox driver records them). */
  checks?: DecisionCheck[]
}

export interface CategorizeMatchedTransactionOpts {
  category: TransactionCategory
  vatTreatment?: VatTreatment
  reverseChargeKind?: ReverseChargeKind
  vatAmount?: number
  notes?: string
  /** Book over a detected possible duplicate (the staged allow_duplicate). */
  allowDuplicate?: boolean
  /** The staged confirm_foreign_seller_vat (CategorizeInput). */
  confirmForeignSellerVat?: boolean
  /**
   * The approver looked at the detected candidate in the app and books anyway:
   * a force bound to that verifikat, re-detected by the guard like the
   * dashboard's "Bokför ändå" (TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH when
   * it no longer matches).
   */
  expectedDuplicateJournalEntryId?: string
  dimensions?: Record<string, string>
  accountOverride?: string
  loadChart?: ChartVatTreatmentsLoader
  /** The suggestion the booking started from (MCP categorize_transaction's proposal_id). */
  proposalId?: string
  /** A bulk door: the person books without seeing this booking's review (CategorizeOptions.withoutReview). */
  withoutReview?: boolean
  /**
   * The door parameter the staging caller named reverseChargeKind with (the
   * staged reverse_charge_box_param). The approval then holds that box
   * against a cost account that reports another ruta 20-24 itself, as the
   * staging did, so a momskod changed in between is refused instead of
   * booking another box than the approver saw. Absent for a box read off
   * the underlag: the account's own box decides, as at staging.
   */
  reverseChargeBoxParam?: ReverseChargeBoxParam
}

/** The staged categorize_transaction as the service's input. */
export function categorizeInputFromStaged(opts: CategorizeMatchedTransactionOpts): CategorizeInput {
  return {
    is_business: opts.category !== 'private',
    category: opts.category,
    vat_treatment: opts.vatTreatment,
    reverse_charge_kind: opts.reverseChargeKind,
    vat_amount: opts.vatAmount,
    account_override: opts.accountOverride,
    dimensions: opts.dimensions,
    notes: opts.notes,
    proposal_id: opts.proposalId,
    allow_duplicate: opts.allowDuplicate,
    ...(opts.confirmForeignSellerVat ? { confirm_foreign_seller_vat: true } : {}),
    ...(opts.expectedDuplicateJournalEntryId
      ? { force: true, expected_duplicate_journal_entry_id: opts.expectedDuplicateJournalEntryId }
      : {}),
  }
}

/**
 * The duplicate refusal as the agent doors word it: what the candidate
 * already books, and the allow_duplicate they rerun with.
 */
export function agentDuplicateMessage(
  candidate: BookedDuplicateCandidate,
  transactionCurrency: string | null | undefined,
): string {
  // Issue #50: the tax is already booked through the skattekonto; the fix
  // is booking the bank line on the skattekonto account, not linking it.
  if (isSkattekontoTaxDouble(candidate)) return skattekontoTaxDoubleAgentMessage(candidate)
  const voucher = candidate.voucher_label ? `verifikat ${candidate.voucher_label}` : 'en befintlig verifikation'
  // Shared three-branch claim (see buildDuplicateBookingClaim above): SEK
  // figure when verified, foreign amount when the sibling has no SEK value,
  // explicit "could not compare" otherwise.
  const claim = buildDuplicateBookingClaim(candidate, transactionCurrency)
  if (candidate.covering) {
    // Issue #101: the row's day is already in a samlingsverifikat. Linking
    // (gnubok_reconcile_match) books the row through it; ignoring
    // (gnubok_ignore_transaction) leaves it out of the books.
    return (
      `Möjlig dubblettbokföring: ${voucher} (${candidate.entry_date}) ${claim}. ` +
      'Transaktionen ingår troligen redan i det samlingsverifikatet: länka den till verifikationen ' +
      '(gnubok_reconcile_match) eller ignorera den (gnubok_ignore_transaction) i stället för att bokföra den igen. ' +
      'Om den verkligen inte ingår, kör om med allow_duplicate=true.'
    )
  }
  return (
    `Möjlig dubblettbokföring: ${voucher} (${candidate.entry_date}) ${claim}. ` +
    'Den här affärshändelsen ser redan ut att vara bokförd: länka transaktionen till den befintliga ' +
    'verifikationen i stället för att bokföra den igen. Om banktransaktionen verkligen är en separat ' +
    'affärshändelse, kör om med allow_duplicate=true.'
  )
}

/**
 * The service options categorizeMatchedTransaction books with. A dry run of
 * the same booking (the filed-momsperiod question of Inkorgen's Bokför
 * valda) takes them from here, so it builds the lines the booking posts.
 */
function matchedTransactionOptions(
  opts: CategorizeMatchedTransactionOpts,
  exclude?: BookingDuplicateExclusions,
): Omit<CategorizeOptions, 'dryRun' | 'log'> {
  return {
    onBooked: 'refuse',
    exclude,
    loadChart: opts.loadChart,
    invoiceMatchIntercept: false,
    ...(opts.withoutReview ? { withoutReview: true } : {}),
    ...(opts.expectedDuplicateJournalEntryId ? { forceVia: 'pending_approval' } : {}),
    // Only with the named kind: the param also reads a missing box off the
    // underlag, and an approval never reads a box anew.
    ...(opts.reverseChargeBoxParam && opts.reverseChargeKind ? { reverseChargeBoxParam: opts.reverseChargeBoxParam } : {}),
  }
}

/**
 * Book a single bank transaction for the approval doors (the categorize
 * executor and the bulk-book-inbox driver): the service, answered in the
 * executor's `{ data } | { error, errorCode, status }` shape.
 *
 * Throws AccountsNotInChartError so the commit path keeps its
 * release-and-retry recovery, and rethrows a bookkeeping error from the
 * engine so commit.ts classifies it as it always has.
 */
export async function categorizeMatchedTransaction(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  txId: string,
  opts: CategorizeMatchedTransactionOpts,
  /**
   * Same-batch siblings to exclude from the duplicate guard. Only set by the
   * bulk driver so intra-batch bookings of DISTINCT same-(date,amount) events
   * never dedupe against one another.
   */
  exclude?: BookingDuplicateExclusions,
): Promise<CategorizeCoreResult> {
  const outcome = await categorizeTransaction(
    supabase,
    userId,
    companyId,
    txId,
    categorizeInputFromStaged(opts),
    matchedTransactionOptions(opts, exclude),
  )
  if (outcome.ok) {
    const booked = outcome.dryRun ? null : outcome.booked
    return {
      data: { journal_entry_id: booked?.journal_entry_id ?? null, category: booked?.category ?? opts.category },
      ...(booked ? { checks: booked.checks } : {}),
    }
  }
  return coreResultFromRefusal(outcome)
}

/** A refusal in the executor's shape; see categorizeMatchedTransaction for the two that throw. */
export function coreResultFromRefusal(refusal: CategorizeRefusal): CategorizeCoreResult {
  if (refusal.code === 'ACCOUNTS_NOT_IN_CHART') {
    throw refusal.cause instanceof AccountsNotInChartError
      ? refusal.cause
      : new AccountsNotInChartError((refusal.details?.account_numbers as string[] | undefined) ?? [])
  }
  if (refusal.code === 'TX_CATEGORIZE_JOURNAL_ENTRY_FAILED') {
    if (isBookkeepingError(refusal.cause)) throw refusal.cause
    return {
      error: refusal.cause instanceof Error ? refusal.cause.message : 'Failed to create journal entry',
      status: 500,
    }
  }
  const entry = getErrorEntry(refusal.code)
  const status = entry?.httpStatus ?? 400
  if (refusal.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE') {
    const candidate = refusal.details?.candidate as BookedDuplicateCandidate | undefined
    if (candidate) {
      // The candidate rides along: the app's approval shows it to the person
      // instead of the agent wording (commit.ts, duplicateReview).
      return {
        error: agentDuplicateMessage(candidate, refusal.transaction?.currency),
        errorCode: refusal.code,
        status,
        data: { candidate },
      }
    }
  }
  return {
    error: refusal.message?.sv ?? entry?.message_sv ?? refusal.code,
    errorCode: refusal.code,
    status,
  }
}

// ── Bulk: book N selected Underlag against their matched transactions ──────

export interface BulkBookInboxInput {
  item_ids: string[]
  category: TransactionCategory
  vat_treatment?: VatTreatment
  vat_amount?: number
  notes?: string
  allow_duplicate?: boolean
  /**
   * Shared dimensions bag applied to the business lines of every generated
   * verifikat in the batch (same semantics as single categorize).
   */
  dimensions?: Record<string, string>
}

export interface BulkBookInboxResult {
  booked: Array<{ item_id: string; transaction_id: string; journal_entry_id: string | null }>
  /** `warning` rides with reason filed_vat_period: what the person is asked to confirm. */
  skipped: Array<{ item_id: string; reason: string; detail?: string; warning?: VoucherWarning }>
}

/**
 * The dashboard door's question about a momsdeklaration already filed, asked
 * per underlag before it is booked (lib/transactions/filed-vat-categorize.ts;
 * handed in, because that module reads this one). An underlag whose booking
 * changes the underlag for a filed declaration is held back, skipped with
 * reason filed_vat_period and the warning, until the person has confirmed;
 * booked past it, the booking is recorded on its verifikat. The approval
 * executor leaves it off: it has nobody to ask.
 */
export interface BulkBookInboxFiledVatQuestion {
  /** The person has read the warning and books anyway. */
  confirmed: boolean
  ask: (
    transactionId: string,
    booking: CategorizeInput,
    options: Omit<CategorizeOptions, 'dryRun' | 'log'>,
  ) => Promise<VoucherWarning | null>
  /** Called for a booking made past the warning. */
  record: (journalEntryId: string, warning: VoucherWarning) => Promise<void>
}

/**
 * Book each selected inbox item against its matched bank transaction with one
 * shared category + VAT treatment. Items without a matched transaction, already
 * booked, already linked to a leverantörsfaktura, or still mid AI extraction
 * (staged upload, status 'processing') are skipped: never an error: so one bad
 * underlag never blocks the rest ("Bokför valda hoppar över"). A per-item throw (period locked, accounts not in chart) is caught and
 * recorded as a skip with the actionable message. Under reverse charge each
 * item books the box its own seller and the category give (ruta 20, 21 or
 * 22), and an item whose box cannot be told, or whose reading shows the
 * seller's VAT, is skipped.
 *
 * Shared by the direct UI route (POST /items/bulk-book) and the
 * `bulk_book_inbox_items` pending-operation executor (Lena-driven flow).
 */
export async function bulkBookMatchedInboxItems(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  input: BulkBookInboxInput,
  options: { filedVat?: BulkBookInboxFiledVatQuestion } = {},
): Promise<BulkBookInboxResult> {
  const { item_ids, category, vat_treatment, vat_amount, notes, allow_duplicate, dimensions } = input

  const booked: BulkBookInboxResult['booked'] = []
  const skipped: BulkBookInboxResult['skipped'] = []

  // Ids booked so far in THIS batch. Passed as exclusions to each subsequent
  // booking so two DISTINCT bank movements the user selected that share a
  // (date, amount, cash account) don't dedupe against each other's freshly
  // minted verifikat. Duplicates that existed BEFORE the batch are absent from
  // these lists, so the guard still catches them (see BookingDuplicateExclusions).
  const bookedTransactionIds: string[] = []
  const bookedJournalEntryIds: string[] = []
  // One read of the company's momskoder for the whole batch, and none unless
  // a reverse-charge item needs it.
  const loadChart = chartVatTreatmentsLoader(supabase, companyId)

  for (const itemId of item_ids) {
    const { data: item, error: itemError } = await supabase
      .from('invoice_inbox_items')
      .select('id, status, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id, channel_context, document_id, extracted_data, matched_supplier_id')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (itemError || !item) {
      skipped.push({ item_id: itemId, reason: 'not_found' })
      continue
    }
    if ((item as { status?: string }).status === 'processing') {
      // Staged upload: the row exists but its deferred AI extraction has not
      // landed yet (extracted_data is NULL). Booking it now would mint a
      // verifikat from an underlag nobody has read; the flip to 'received'
      // arrives within seconds, so this is a "try again in a moment" skip.
      skipped.push({ item_id: itemId, reason: 'extraction_in_progress' })
      continue
    }
    if (item.created_journal_entry_id) {
      skipped.push({ item_id: itemId, reason: 'already_booked' })
      continue
    }
    if (item.created_supplier_invoice_id) {
      skipped.push({ item_id: itemId, reason: 'is_supplier_invoice' })
      continue
    }
    if (!item.matched_transaction_id) {
      skipped.push({ item_id: itemId, reason: 'not_matched' })
      continue
    }
    // The other half of this purchase (the invoice or the receipt it came with) is booked already:
    // booking this one's row too would book the purchase twice. The detail names that verifikat.
    const pairBooked = await refuseWhenPairBooked(supabase, companyId, itemId)
    if (pairBooked) {
      skipped.push({ item_id: itemId, reason: 'pair_already_booked', detail: pairBooked.messageSv })
      continue
    }

    // Omvänd skattskyldighet: the box (ruta 20, 21 or 22) belongs to this
    // purchase, read off its own seller and the shared category, never to the
    // batch. An item whose box cannot be told is left out with the reason
    // (lib/vat/reverse-charge-box.ts) instead of landing in ruta 21 by default.
    let reverseChargeKind: ReverseChargeKind | undefined
    // An underlag that shows the seller's VAT is left out of a bulk reverse
    // charge (#94), as the single door refuses it by default
    // (TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT) and the Inkorg's one click
    // sends it to the editor. Whether the charge is foreign VAT debited in
    // error is stated per purchase at the single door (crm#1765), never for
    // a batch.
    const sellerVat = vat_treatment === 'reverse_charge' ? sellerChargedVat(item.extracted_data as ChargedVatReading | null) : 0
    if (sellerVat > 0) {
      const currency = (item.extracted_data as { invoice?: { currency?: string | null } } | null)?.invoice?.currency
      const amount = [sellerVat.toLocaleString('sv-SE'), currency].filter(Boolean).join(' ')
      skipped.push({
        item_id: itemId,
        reason: 'reverse_charge_seller_vat',
        detail:
          `Underlaget visar att säljaren har debiterat moms (${amount}). Bokför underlaget för sig: svensk moms som ` +
          'ingående moms. Är det utländsk moms som säljaren debiterat felaktigt bokförs köpet med omvänd skattskyldighet ' +
          `på hela beloppet, bekräftat för det köpet (${FOREIGN_SELLER_VAT_FLAG}).`,
      })
      continue
    }
    if (vat_treatment === 'reverse_charge' && category.startsWith('expense_')) {
      const box = reverseChargeBoxFor(await inboxItemSellerRegion(supabase, companyId, item), category)
      if (!box.ok) {
        skipped.push({ item_id: itemId, reason: 'reverse_charge_box_unknown', detail: box.messageSv })
        continue
      }
      reverseChargeKind = box.kind
    }

    // WhatsApp-sourced underlag carry verified human context (representation
    // deltagare + syfte, sender note) in channel_context. Thread it into the
    // verifikat description ALONGSIDE the caller's shared batch note: bulk
    // booking never shows a per-item notes field, so dropping the chat
    // answers here would silently lose the Skatteverket representation
    // documentation that only exists on this one item.
    //
    // Answers only, never the photo caption (the renderer leaves it out
    // unless asked for it): this loop books without any per-item review and
    // the verifikat description is immutable under BFL 5 kap, so unreviewed
    // chat text must not land there. Captions only reach a verifikat through
    // Bokför direkt, where the user reads them in an editable field first.
    const channelNotes = renderChannelContextNotes(
      (item as { channel_context?: InboxChannelContext | null }).channel_context,
    )
    const itemNotes =
      [notes?.trim(), channelNotes].filter(Boolean).join(' · ') || undefined

    const booking: CategorizeMatchedTransactionOpts = {
      category,
      vatTreatment: vat_treatment,
      reverseChargeKind,
      vatAmount: vat_amount,
      notes: itemNotes,
      allowDuplicate: allow_duplicate,
      dimensions,
      loadChart,
      withoutReview: true,
    }
    // Snapshot copies so the guard sees only the prior bookings of this batch.
    const exclude: BookingDuplicateExclusions = {
      excludeTransactionIds: [...bookedTransactionIds],
      excludeJournalEntryIds: [...bookedJournalEntryIds],
    }

    // A booking that changes the underlag for a momsdeklaration already filed
    // waits for the person's word (the dashboard door only). Asked on the
    // confirmed send too, so the booking made past it is known as one.
    let filedVat: VoucherWarning | null = null
    if (options.filedVat) {
      filedVat = await options.filedVat.ask(
        item.matched_transaction_id as string,
        categorizeInputFromStaged(booking),
        matchedTransactionOptions(booking, exclude),
      )
      if (filedVat && !options.filedVat.confirmed) {
        skipped.push({ item_id: itemId, reason: 'filed_vat_period', detail: filedVat.message_sv, warning: filedVat })
        continue
      }
    }

    // The model's reading of the underlag, taken before the booking.
    const extractionSnapshot = await snapshotInboxExtraction(supabase, companyId, item)

    let result: CategorizeCoreResult
    try {
      result = await categorizeMatchedTransaction(
        supabase,
        userId,
        companyId,
        item.matched_transaction_id as string,
        booking,
        exclude,
      )
    } catch (err) {
      // Caught per-item (incl. AccountsNotInChartError / period-lock bookkeeping
      // errors) so the batch keeps going. The message carries the actionable
      // detail (e.g. which BAS accounts to activate).
      skipped.push({
        item_id: itemId,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (result.error) {
      const reason =
        result.errorCode === 'PERIOD_LOCKED' ||
        result.errorCode === 'TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED' ||
        result.errorCode === 'NO_OPEN_PERIOD_FOR_DATE'
          ? 'no_open_period'
          // A foreign row with no SEK value is not a mapping problem: the
          // repair is fetching its exchange rate.
          : result.errorCode === 'TX_MISSING_SEK_VALUE' ? 'missing_sek_value'
          // A booking review rule matches (accounted#130): a person books it from its review.
          : result.errorCode === 'TX_CATEGORIZE_REVIEW_REQUIRED' || result.errorCode === 'BOOKING_REVIEW_REQUIRED' ? 'booking_review_required'
          : result.status === 404 ? 'transaction_not_found'
          : result.status === 409 ? 'already_booked_or_duplicate'
          : result.status === 400 ? 'no_account_mapping'
          : 'error'
      skipped.push({ item_id: itemId, reason, detail: result.error })
      continue
    }

    const bookedTxId = item.matched_transaction_id as string
    const bookedJeId = (result.data?.journal_entry_id as string | null) ?? null
    // Record this booking so it is excluded from the NEXT item's duplicate guard.
    bookedTransactionIds.push(bookedTxId)
    if (bookedJeId) bookedJournalEntryIds.push(bookedJeId)
    booked.push({
      item_id: itemId,
      transaction_id: bookedTxId,
      journal_entry_id: bookedJeId,
    })
    if (filedVat && bookedJeId) await options.filedVat?.record(bookedJeId, filedVat)

    // The bank line's own row came from categorizeMatchedTransaction; this
    // one records the underlag: booked as read, or with a total that differs.
    // Its guards are the bank line's booking's: that is what booked the
    // underlag. The item was checked unbooked above, so already_booked
    // covers both.
    const postedLines = await loadEntryLines(supabase, companyId, bookedJeId)
    await recordInboxDecision(supabase, extractionSnapshot, {
      journal_entry_id: bookedJeId,
      fields: postedLines.length > 0 ? bookedTotals(postedLines) : {},
      lines: postedLines,
    }, userId, [passed('already_booked'), ...(result.checks ?? []).filter((c) => c.id !== 'already_booked')])
  }

  return { booked, skipped }
}

/** A document's reading, as far as the seller's charge and country go (the extraction's shape fits). */
type UnderlagReading =
  | (ChargedVatReading & { totals?: { total?: number; vatAmount?: number } | null; invoice?: { currency?: string } | null; supplier?: SellerIdentity | null })
  | null

/**
 * The documents a single categorize reads as the purchase's underlag, the
 * row's own first: on a preview, the row's document; for a reverse charge,
 * also every inbox item's document the booking anchors on the verifikat
 * (propagateUnderlagForBookedTransaction): the item it started from and the
 * items matched to the row, unless another booking took them. Each is checked
 * for the seller's VAT as the bulk door checks an item, so none is booked as
 * reverse charge without the caller's word.
 */
async function categorizeUnderlagDocuments(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  input: CategorizeInput,
  dryRun: boolean,
): Promise<Array<{ id: string; reading: UnderlagReading }>> {
  const reverseCharge = input.vat_treatment === 'reverse_charge'
  const documents: Array<{ id: string; reading: UnderlagReading }> = []
  const add = (id: string | null | undefined, reading: unknown) => {
    if (id && !documents.some((one) => one.id === id)) documents.push({ id, reading: (reading ?? null) as UnderlagReading })
  }
  if (transaction.document_id && (dryRun || reverseCharge)) {
    const { data: doc } = await supabase
      .from('document_attachments')
      .select('id, extracted_data')
      .eq('id', transaction.document_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (doc) add(doc.id as string, doc.extracted_data)
  }
  if (!reverseCharge) return documents
  if (input.inbox_item_id) {
    const { data: item } = await supabase
      .from('invoice_inbox_items')
      .select('document_id, extracted_data')
      .eq('id', input.inbox_item_id)
      .eq('company_id', companyId)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
      .maybeSingle()
    const one = item as { document_id?: string | null; extracted_data?: unknown } | null
    add(one?.document_id, one?.extracted_data)
  }
  const { data: matched } = await supabase
    .from('invoice_inbox_items')
    .select('document_id, extracted_data')
    .eq('company_id', companyId)
    .eq('matched_transaction_id', transaction.id)
    .is('created_journal_entry_id', null)
    .is('created_supplier_invoice_id', null)
  for (const one of (Array.isArray(matched) ? matched : []) as Array<{ document_id?: string | null; extracted_data?: unknown }>) {
    add(one.document_id, one.extracted_data)
  }
  return documents
}

/**
 * Where an inbox item's seller is, by its id: the single door's underlag when
 * the bank row has no document of its own yet (#94). Null for an item of
 * another company or none.
 */
async function inboxItemSellerRegionById(
  supabase: SupabaseClient,
  companyId: string,
  itemId: string,
): Promise<SellerRegion | null> {
  const { data: item } = await supabase
    .from('invoice_inbox_items')
    .select('extracted_data, matched_supplier_id')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .maybeSingle()
  return item ? inboxItemSellerRegion(supabase, companyId, item as { extracted_data?: unknown; matched_supplier_id?: string | null }) : null
}

/**
 * Where an inbox item's seller is: its reading, then a matched supplier
 * card's type (read only when the reading says nothing). The one reading
 * both the bulk booking and the single agent/API door use.
 */
async function inboxItemSellerRegion(
  supabase: SupabaseClient,
  companyId: string,
  item: { extracted_data?: unknown; matched_supplier_id?: string | null },
): Promise<SellerRegion | null> {
  const reading = (item.extracted_data as { supplier?: SellerIdentity | null } | null)?.supplier ?? null
  const fromReading = purchaseSellerRegion(reading)
  if (fromReading || !item.matched_supplier_id) return fromReading
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('supplier_type')
    .eq('id', item.matched_supplier_id)
    .eq('company_id', companyId)
    .maybeSingle()
  return purchaseSellerRegion(reading, (supplier as { supplier_type?: string | null } | null)?.supplier_type)
}
