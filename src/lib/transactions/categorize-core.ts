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
import { eventBus } from '@/lib/events'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { applyAccountOverride } from '@/lib/bookkeeping/account-override'
import { applyVatAmountOverride } from '@/lib/bookkeeping/vat-amount-override'
import {
  getTemplateById,
  buildMappingResultFromTemplate,
  validateTemplateForEntity,
} from '@/lib/bookkeeping/booking-templates'
import { reconcileRcBasisWithChart } from '@/lib/bookkeeping/rc-basis-reconcile'
import { chartVatTreatmentsLoader, type ChartVatTreatmentsLoader } from '@/lib/bookkeeping/chart-vat-treatments'
import { applySettlementAccount, saveUserMappingRule } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { guardCounterLegs } from '@/lib/cash-accounts/service'
import { buildTransactionEntryLines, createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { finalFromCategorize, recordDecisions, snapshotSuggestions, type SuggestionSnapshot } from '@/lib/suggestion-log/record'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { bookedTotals } from '@/lib/suggestion-log/inbox-classify'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { getEarliestFiscalPeriodStart } from '@/lib/core/bookkeeping/period-service'
import {
  upsertCounterpartyTemplate,
  buildMappingResultFromCounterpartyTemplate,
  loadCounterpartyTemplateMatch,
} from '@/lib/bookkeeping/counterparty-templates'
import {
  AccountsNotInChartError,
  isBookkeepingError,
  TransactionMissingSekValueError,
} from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
  type BookingDuplicateExclusions,
  type BookingTarget,
} from '@/lib/transactions/booking-duplicate-detection'
import { runBookingDuplicateGuard } from '@/lib/transactions/booking-duplicate-guard'
import { assertTransactionBookable } from '@/lib/transactions/is-booked'
import { findInvoiceMatchSuggestion } from '@/lib/transactions/invoice-match-suggestion'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger, type Logger } from '@/lib/logger'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import type {
  CreateJournalEntryLineInput,
  InboxChannelContext,
  JournalEntry,
  MappingResult,
  Transaction,
  TransactionCategory,
  VatTreatment,
} from '@/types'
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'

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
  /** Basis box of a reverse-charge purchase (ruta 20/21/22); omitted = EU services. */
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
  confirm_no_match?: boolean
  force?: boolean
  expected_duplicate_transaction_id?: string
  expected_duplicate_journal_entry_id?: string
  /**
   * Agent doors: book over a detected possible duplicate without naming it
   * (the staged allow_duplicate). The dismissal is recorded all the same.
   */
  allow_duplicate?: boolean
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
  log?: Logger
}

/** The pinned document's own reading, shown on a preview. */
export interface CategorizeUnderlag {
  document_id: string
  total: number | null
  vat_amount: number | null
  currency: string | null
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
}

export interface CategorizeBooked {
  journal_entry_created: boolean
  journal_entry_id: string | null
  category: TransactionCategory
  already_had_journal_entry: boolean
  transaction: Transaction
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
function resolveFinalCategory(input: CategorizeInput): TransactionCategory {
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
 */
export function buildDuplicateBookingClaim(
  dup: Pick<BookedDuplicateCandidate, 'amount' | 'currency' | 'amount_in_currency' | 'amount_verified'>,
  transactionCurrency: string | null | undefined,
): string {
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

  // Pre-FY guard (issue #1825): a date before the company's first fiscal
  // period must NEVER mint a calendar-year rakenskapsar. Depending on overlap
  // with the real first period, the upsert below would either bounce off the
  // no_overlapping_fiscal_periods exclusion constraint (log noise) or silently
  // create a pre-registration year (legally wrong). Return true and let the
  // pre-FY clamp in createTransactionJournalEntry book the event on the first
  // fiscal year's first day. Dates AFTER the latest period (next-year
  // auto-creation) pass through unchanged.
  const earliestStart = await getEarliestFiscalPeriodStart(supabase, companyId)
  if (earliestStart && date < earliestStart) return true

  const txDate = new Date(date)
  const txMonth = txDate.getMonth() + 1
  const txYear = txDate.getFullYear()

  let periodStartYear: number
  if (fiscalYearStartMonth === 1) {
    periodStartYear = txYear
  } else if (txMonth >= fiscalYearStartMonth) {
    periodStartYear = txYear
  } else {
    periodStartYear = txYear - 1
  }

  const startMonth = String(fiscalYearStartMonth).padStart(2, '0')
  const periodStart = `${periodStartYear}-${startMonth}-01`

  const endYear = fiscalYearStartMonth === 1 ? periodStartYear : periodStartYear + 1
  const endMonth = fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1
  const lastDay = new Date(endYear, endMonth, 0).getDate()
  const periodEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const periodName = fiscalYearStartMonth === 1
    ? `Räkenskapsår ${periodStartYear}`
    : `Räkenskapsår ${periodStartYear}/${endYear}`

  // The arbiter must name a real unique constraint, or Postgres refuses the
  // insert (42P10): the key is per company since the multi-tenant refactor.
  // An existing row with these dates (a closed year the select above skips)
  // is left as it is; the booking then meets that year's lock.
  const { error } = await supabase
    .from('fiscal_periods')
    .upsert({
      user_id: userId,
      company_id: companyId,
      name: periodName,
      period_start: periodStart,
      period_end: periodEnd,
    }, { onConflict: 'company_id,period_start,period_end', ignoreDuplicates: true })

  if (error) {
    log.error('Failed to create fiscal period:', error)
    return false
  }
  return true
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
  let wouldBook = true
  if (!bookable.ok) {
    const flagsOnly = options.onBooked === 'update_flags' && bookable.via === 'pointer'
    if (!flagsOnly) {
      return refuseFor(bookable.code, { journal_entry_id: bookable.journalEntryId, via: bookable.via })
    }
    if (!dryRun) return updateFlagsOnly(supabase, companyId, transaction, input)
    // A dry run on a booked row previews the kontering a fresh row would get.
    wouldBook = false
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
  }

  // Booking-time duplicate guard: refuse a second verifikat for an
  // affärshändelse the ledger already books (TRANSACTION_BOOK_POSSIBLE
  // _DUPLICATE). `force` bound to the reviewed candidate books anyway; the
  // agent doors' allow_duplicate does too without naming it. Either bypass
  // leaves a behandlingshistorik record on a live call (BFNAR 2013:2 p. 9.16).
  if (wouldBook) {
    if (input.allow_duplicate === true) {
      if (!dryRun) await recordAllowedDuplicate(supabase, companyId, userId, target, options.exclude, txLog)
    } else {
      const verdict = await runBookingDuplicateGuard(supabase, companyId, userId, target, input, txLog, {
        exclude: options.exclude,
        recordDismissal: !dryRun,
        via: options.forceVia,
      })
      if (!verdict.ok) return refuseFor(verdict.code, verdict.details as Record<string, unknown>)
    }
  }

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
      return refuseFor('TX_CATEGORIZE_INVALID_TEMPLATE', { templateId: input.template_id, reason: 'unknown_template' })
    }
    const valid = validateTemplateForEntity(template, entityType)
    if (!valid.valid) {
      return refuseFor('TX_CATEGORIZE_INVALID_TEMPLATE', { templateId: input.template_id, reason: valid.error })
    }
  }
  const finalCategory = resolveFinalCategory(input)

  // The pinned document's own reading: shown on a preview, and the check that
  // a reverse-charge booking is not made on an invoice where the seller
  // already charged moms (that produced fictive 2645/2614 lines on 25 % of a
  // foreign charge). Omvänd skattskyldighet only covers invoices without the
  // seller's VAT; the foreign VAT is then part of the cost.
  let underlag: CategorizeUnderlag | null = null
  if (transaction.document_id && (dryRun || input.vat_treatment === 'reverse_charge')) {
    const { data: doc } = await supabase
      .from('document_attachments')
      .select('id, extracted_data')
      .eq('id', transaction.document_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (doc) {
      const ex = (doc.extracted_data ?? null) as
        | { totals?: { total?: number; vatAmount?: number }; invoice?: { currency?: string } }
        | null
      underlag = {
        document_id: doc.id as string,
        total: ex?.totals?.total ?? null,
        vat_amount: ex?.totals?.vatAmount ?? null,
        currency: ex?.invoice?.currency ?? null,
      }
      if (input.vat_treatment === 'reverse_charge' && (underlag.vat_amount ?? 0) > 0) {
        return refuseFor(
          'TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT',
          { document_id: underlag.document_id, seller_vat_amount: underlag.vat_amount, currency: underlag.currency },
          {
            message: {
              sv:
                `Omvänd skattskyldighet avvisas: underlaget (document_id=${underlag.document_id}) visar att säljaren redan har debiterat moms ` +
                `(${underlag.vat_amount} ${underlag.currency ?? ''}). Omvänd skattskyldighet gäller bara fakturor utan säljarens moms. ` +
                'Bokför som vanlig kostnad (utan vat_treatment, eller standard_25 om svensk faktura): den utländska momsen ingår i kostnaden.',
            },
          },
        )
      }
    }
  }

  let mappingResult: MappingResult
  if (input.counterparty_template_id && isBusiness) {
    // Learned codes the registry no longer accepts are dropped on load; an
    // explicit input.dimensions (applied below) is never filtered.
    const match = await loadCounterpartyTemplateMatch(supabase, companyId, input.counterparty_template_id)
    if (!match) {
      return refuseFor('NOT_FOUND', { resource: 'counterparty_template', id: input.counterparty_template_id })
    }
    mappingResult = buildMappingResultFromCounterpartyTemplate(match, transaction, entityType, vatRegistered)
  } else if (template) {
    mappingResult = buildMappingResultFromTemplate(template, transaction, entityType, vatRegistered)
    if (input.vat_amount != null) {
      // The underlag's moms replaces the template's rate-based line; the
      // helper refuses a treatment it cannot apply to.
      try {
        mappingResult = applyVatAmountOverride(mappingResult, transaction, template.vat_treatment, input.vat_amount)
      } catch (err) {
        return refuseFor('TX_CATEGORIZE_INVALID_VAT_AMOUNT', {
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
      return refuseFor('TX_CATEGORIZE_INVALID_VAT_AMOUNT', {
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
    txLog,
    transaction.currency,
  )
  mappingResult = applySettlementAccount(mappingResult, settlementAccount, transaction.amount)

  // The override replaces the business side of a category booking, never a
  // template's or a learned template's accounts. Re-validated at every
  // booking: the account can be deactivated between staging and approval.
  if (input.account_override && !template && !(input.counterparty_template_id && isBusiness)) {
    if (!isBusiness) {
      return refuseFor(
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
      )
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (typeof code !== 'string') throw err
      return refuseFor(code, { accountNumber: input.account_override }, {
        message: { sv: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // A reverse-charge purchase keeps its 45xx/4598 basis pair only when the
  // account its cost line lands on (after any account_override) does not
  // report ruta 20-24 itself, by the company's momskoder (crm#1096, #2919).
  mappingResult = await reconcileRcBasisWithChart(
    mappingResult,
    options.loadChart ?? chartVatTreatmentsLoader(supabase, companyId),
  )

  // An explicit bag tags the business lines (bank/VAT legs stay untagged); it
  // wins over a learned counterparty-template bag.
  if (input.dimensions && Object.keys(input.dimensions).length > 0) {
    mappingResult.dimensions = input.dimensions
  }

  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return refuseFor('TX_CATEGORIZE_INVALID_MAPPING', {
      debitAccount: mappingResult.debit_account,
      creditAccount: mappingResult.credit_account,
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
    return refuseFor('TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT', { accountNumber: guarded.refusedLedger }, {
      message: {
        sv: `Motkontot ${guarded.refusedLedger} är ett bankkonto som hör till transaktionens eget konto eller till en frånkopplad bankanslutning och kan inte användas. Välj ett intäkts- eller kostnadskonto i stället.`,
      },
    })
  }
  mappingResult = guarded.mappingResult

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

  // Invoice-match intercept: a plain 244x / 151x categorization an open
  // supplier / customer invoice covers is refused with the candidates, so the
  // payment is matched instead of booked twice; confirm_no_match keeps it.
  if (wouldBook && options.invoiceMatchIntercept !== false) {
    const invoiceSuggestion = await findInvoiceMatchSuggestion(
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
  }

  if (wouldBook) {
    if (!dryRun) {
      await ensureFiscalPeriod(supabase, userId, companyId, transaction.date, settings?.fiscal_year_start_month ?? 1)
    }
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
  }

  if (dryRun) {
    let lines: CreateJournalEntryLineInput[]
    try {
      lines = buildTransactionEntryLines(transaction, mappingResult)
    } catch (err) {
      if (err instanceof TransactionMissingSekValueError) return missingSekRefusal(err, transaction)
      throw err
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
      },
    }
  }

  // What was on offer, taken before the booking and its learning.
  const suggestionSnapshot = options.suggestionSnapshot ?? (await snapshotSuggestions(supabase, companyId, [txId]))
  let bookedEntry: JournalEntry | null
  try {
    bookedEntry = await createTransactionJournalEntry(supabase, companyId, userId, transaction, mappingResult, input.notes)
  } catch (err) {
    // An account deactivated between the check above and the engine call.
    if (err instanceof AccountsNotInChartError) {
      return refuseFor('ACCOUNTS_NOT_IN_CHART', { account_numbers: err.accountNumbers }, {
        message: { sv: `Följande konton behöver aktiveras: ${err.accountNumbers.join(', ')}` },
        cause: err,
      })
    }
    if (err instanceof TransactionMissingSekValueError) return missingSekRefusal(err, transaction)
    // Fail closed (issue #1947): the verifikat IS the booking, so nothing is
    // written and the row stays in "Att bokföra".
    txLog.error('journal entry creation failed', err as Error)
    const sv = getErrorMessage(err, { context: 'transaction' })
    return refuseFor('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED', { cause: getStructuredError(err).code, message: sv }, {
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
    final: finalFromCategorize({
      journalEntry: bookedEntry,
      mappingResult,
      amount: transaction.amount,
      templateId: input.template_id ?? null,
      counterpartyTemplateId: input.counterparty_template_id ?? null,
      category: isBusiness ? (input.category ?? finalCategory) : 'private',
      vatTreatment: input.vat_treatment ?? null,
    }),
  }], userId)

  // Compare-and-set on the pointer as read: a concurrent booking of the same
  // row must not be overwritten. A stale pointer at a reversed verifikat is
  // replaced only if nobody changed it meanwhile.
  const updateQuery = supabase
    .from('transactions')
    .update({ is_business: isBusiness, category: finalCategory, is_ignored: false, journal_entry_id: bookedEntry.id })
    .eq('id', txId)
    .eq('company_id', companyId)
  const guardedUpdate = transaction.journal_entry_id
    ? updateQuery.eq('journal_entry_id', transaction.journal_entry_id)
    : updateQuery.is('journal_entry_id', null)
  const { data: updated, error: updateError } = await guardedUpdate.select('*')
  if (updateError || !updated || updated.length === 0) {
    await reverseOrphanedJournalEntry(supabase, companyId, userId, bookedEntry.id, ORPHAN_REVERSAL_NOTE)
    if (updateError) {
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
      await saveUserMappingRule(
        supabase,
        companyId,
        transaction.merchant_name,
        mappingResult.debit_account,
        mappingResult.credit_account,
        !isBusiness,
        input.user_description,
        input.template_id,
      )
    } catch (err) {
      txLog.warn('failed to save mapping rule (non-critical)', err as Error)
    }
  }
  try {
    await upsertCounterpartyTemplate(supabase, companyId, transaction, mappingResult, 'user_approved')
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
): Promise<void> {
  try {
    const dismissed = await detectBookingDuplicate(supabase, companyId, target, exclude)
    if (!dismissed) return
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
}

export interface CategorizeMatchedTransactionOpts {
  category: TransactionCategory
  vatTreatment?: VatTreatment
  reverseChargeKind?: ReverseChargeKind
  vatAmount?: number
  notes?: string
  /** Book over a detected possible duplicate (the staged allow_duplicate). */
  allowDuplicate?: boolean
  dimensions?: Record<string, string>
  accountOverride?: string
  loadChart?: ChartVatTreatmentsLoader
  /** The suggestion the booking started from (MCP categorize_transaction's proposal_id). */
  proposalId?: string
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
  const voucher = candidate.voucher_label ? `verifikat ${candidate.voucher_label}` : 'en befintlig verifikation'
  // Shared three-branch claim (see buildDuplicateBookingClaim above): SEK
  // figure when verified, foreign amount when the sibling has no SEK value,
  // explicit "could not compare" otherwise.
  const claim = buildDuplicateBookingClaim(candidate, transactionCurrency)
  return (
    `Möjlig dubblettbokföring: ${voucher} (${candidate.entry_date}) ${claim}. ` +
    'Den här affärshändelsen ser redan ut att vara bokförd: länka transaktionen till den befintliga ' +
    'verifikationen i stället för att bokföra den igen. Om banktransaktionen verkligen är en separat ' +
    'affärshändelse, kör om med allow_duplicate=true.'
  )
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
  const outcome = await categorizeTransaction(supabase, userId, companyId, txId, categorizeInputFromStaged(opts), {
    onBooked: 'refuse',
    exclude,
    loadChart: opts.loadChart,
    invoiceMatchIntercept: false,
  })
  if (outcome.ok) {
    const booked = outcome.dryRun ? null : outcome.booked
    return { data: { journal_entry_id: booked?.journal_entry_id ?? null, category: booked?.category ?? opts.category } }
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
      return { error: agentDuplicateMessage(candidate, refusal.transaction?.currency), errorCode: refusal.code, status }
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
  skipped: Array<{ item_id: string; reason: string; detail?: string }>
}

/**
 * Book each selected inbox item against its matched bank transaction with one
 * shared category + VAT treatment. Items without a matched transaction, already
 * booked, already linked to a leverantörsfaktura, or still mid AI extraction
 * (staged upload, status 'processing') are skipped: never an error: so one bad
 * underlag never blocks the rest ("Bokför valda hoppar över"). A per-item throw (period locked, accounts not in chart) is caught and
 * recorded as a skip with the actionable message.
 *
 * Shared by the direct UI route (POST /items/bulk-book) and the
 * `bulk_book_inbox_items` pending-operation executor (Lena-driven flow).
 */
export async function bulkBookMatchedInboxItems(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  input: BulkBookInboxInput,
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
      .select('id, status, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id, channel_context, document_id, extracted_data')
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

    // The model's reading of the underlag, taken before the booking.
    const extractionSnapshot = await snapshotInboxExtraction(supabase, companyId, item)

    let result: CategorizeCoreResult
    try {
      result = await categorizeMatchedTransaction(
        supabase,
        userId,
        companyId,
        item.matched_transaction_id as string,
        { category, vatTreatment: vat_treatment, vatAmount: vat_amount, notes: itemNotes, allowDuplicate: allow_duplicate, dimensions, loadChart },
        // Snapshot copies so the guard sees only the prior bookings of this batch.
        { excludeTransactionIds: [...bookedTransactionIds], excludeJournalEntryIds: [...bookedJournalEntryIds] },
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

    // The bank line's own row came from categorizeMatchedTransaction; this
    // one records the underlag: booked as read, or with a total that differs.
    const postedLines = await loadEntryLines(supabase, companyId, bookedJeId)
    await recordInboxDecision(supabase, extractionSnapshot, {
      journal_entry_id: bookedJeId,
      fields: postedLines.length > 0 ? bookedTotals(postedLines) : {},
      lines: postedLines,
    }, userId)
  }

  return { booked, skipped }
}
