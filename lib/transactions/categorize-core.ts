/**
 * Shared core for booking a bank transaction by category.
 *
 * This is the single implementation behind three callers:
 *   1. The single-transaction approval executor `commitCategorizeTransaction`
 *      (lib/pending-operations/commit.ts): the agent / web "Kategorisera"
 *      flow.
 *   2. The bulk-book-inbox executor `commitBulkBookInboxItems`
 *      (lib/pending-operations/commit.ts): Lena driving the Underlag view.
 *   3. The direct UI bulk-book route (`POST /items/bulk-book` in the
 *      invoice-inbox extension): the "Bokför valda" button.
 *
 * Extracting it keeps the VAT/mapping logic, the duplicate guard, and the
 * matched-inbox underlag propagation in ONE place. "Booking an underlag" in the
 * Dokumentinkorgen is implemented as categorizing the bank transaction it is
 * matched to: `buildMappingResultFromCategory` produces correct accounts +
 * reverse-charge VAT, and the propagation step below attaches the underlag to
 * the new verifikation (BFL 7 kap) and stamps the inbox item resolved.
 *
 * Booking is always in SEK off the bank transaction's own amount (BFL 5 kap
 * 2§), so the foreign-currency underlag never needs an FX step here: the bank
 * already settled it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { applyAccountOverride } from '@/lib/bookkeeping/account-override'
import { applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
  type BookingDuplicateExclusions,
} from '@/lib/transactions/booking-duplicate-detection'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import type { InboxChannelContext, Transaction, TransactionCategory, EntityType, VatTreatment } from '@/types'

const log = createLogger('transactions/categorize-core')

/** Structurally compatible with the commit.ts `ExecutorResult`. */
export interface CategorizeCoreResult {
  data?: Record<string, unknown>
  error?: string
  status?: number
}

export interface CategorizeMatchedTransactionOpts {
  category: TransactionCategory
  vatTreatment?: VatTreatment
  /**
   * The underlag's actual VAT when it differs from rate × belopp (e.g. dricks).
   * Only valid with a rate-based vat_treatment; see buildMappingResultFromCategory.
   */
  vatAmount?: number
  /** Audit-trail text appended to the verifikation description. */
  notes?: string
  /**
   * Bypass the booking-time duplicate guard. Default false: the guard fails
   * closed when another verifikat already books this amount on the bank
   * account, and the caller surfaces the skip.
   */
  allowDuplicate?: boolean
  /**
   * Dimensions PR7: bag applied to the business (expense/revenue) lines of the
   * generated verifikat: bank/VAT lines stay untagged. Resolved against the
   * registry at staging time (MCP) or picked in the UI.
   */
  dimensions?: Record<string, string>
  /**
   * Explicit business-side account (e.g. a company-custom VMB account) that
   * replaces the category's debit (money out) or credit (money in) account,
   * with the same semantics as the v1 REST route's account_override: must be
   * present and active in chart_of_accounts, never combined with category
   * 'private'. See lib/bookkeeping/account-override.ts.
   */
  accountOverride?: string
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

  const { error } = await supabase
    .from('fiscal_periods')
    .upsert({
      user_id: userId,
      company_id: companyId,
      name: periodName,
      period_start: periodStart,
      period_end: periodEnd,
    }, { onConflict: 'user_id,period_start,period_end' })

  if (error) {
    log.error('Failed to create fiscal period:', error)
    return false
  }
  return true
}

/**
 * Book a single bank transaction by category. Creates the verifikation, marks
 * the transaction booked, propagates any matched invoice-inbox underlag onto
 * the new entry (stamping `created_journal_entry_id` so the inbox row moves to
 * "Bearbetade"), and records the counterparty template.
 *
 * Returns `{ data }` on success or `{ error, status }` on a recoverable
 * failure (404 missing tx, 409 already booked / possible duplicate, 400 no
 * mapping, 500 DB). Throws only on AccountsNotInChartError so the caller's
 * recover-and-retry path stays intact.
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
   * never dedupe against one another. Omitted (single-booking callers) = the
   * full guard runs unchanged.
   */
  exclude?: BookingDuplicateExclusions,
): Promise<CategorizeCoreResult> {
  const { category, vatTreatment, vatAmount, notes, allowDuplicate, dimensions, accountOverride } = opts

  const { data: transaction, error: fetchError } = await supabase
    .from('transactions').select('*').eq('id', txId).eq('company_id', companyId).single()

  if (fetchError || !transaction) {
    return { error: 'Transaction not found: it may have been deleted.', status: 404 }
  }
  // A stale pointer at a 'reversed' entry (storno/correction left it behind)
  // must not block re-categorization: the row reads as "utan koppling" in the
  // UI, so a fresh booking has to be allowed (issue #988). Only a live posted
  // link means it was genuinely categorized in the meantime. The UPDATE below
  // uses the observed stale pointer as its CAS value, so it only replaces the
  // pointer if no concurrent request changed it. The duplicate guard still
  // catches an existing live correction and steers the user to link instead.
  if (
    transaction.journal_entry_id &&
    (await hasLiveJournalEntryLink(supabase, companyId, transaction.journal_entry_id))
  ) {
    return { error: 'Transaction already has a journal entry: it was categorized in the meantime.', status: 409 }
  }

  // Booking-time duplicate guard: parity with the web /categorize route.
  // Refuse to mint a second verifikat for an affärshändelse already in the
  // ledger: an already-booked sibling transaction, OR an unlinked voucher that
  // already books this amount on the bank account (invoice "markera som
  // betald", the salary run's net-wage payout, a manual verifikat). Fail
  // closed; the caller re-runs with allowDuplicate=true after the user
  // confirms the bank line is a genuinely separate event. Fail-open on a
  // detection error so a transient query failure never blocks a real booking.
  if (allowDuplicate !== true) {
    let dup = null
    try {
      dup = await detectBookingDuplicate(supabase, companyId, {
        id: txId,
        date: transaction.date,
        amount: transaction.amount,
        // `amount` is denominated in `currency`; the ledger legs the guard
        // compares it against are always SEK. Selected above via select('*').
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
      }, exclude)
    } catch (err) {
      log.warn('booking-time duplicate detection failed (continuing)', err)
    }
    if (dup) {
      const voucher = dup.voucher_label ? `verifikat ${dup.voucher_label}` : 'en befintlig verifikation'
      // Shared three-branch claim (see buildDuplicateBookingClaim above): SEK
      // figure when verified, foreign amount when the sibling has no SEK
      // value, explicit "could not compare" otherwise.
      const claim = buildDuplicateBookingClaim(dup, transaction.currency)
      return {
        error:
          `Möjlig dubblettbokföring: ${voucher} (${dup.entry_date}) ${claim}. ` +
          `Den här affärshändelsen ser redan ut att vara bokförd: länka transaktionen till den befintliga ` +
          `verifikationen i stället för att bokföra den igen. Om banktransaktionen verkligen är en separat ` +
          `affärshändelse, kör om med allow_duplicate=true.`,
        status: 409,
      }
    }
  } else {
    // allowDuplicate=true bypassed the guard. Booking over a possible
    // double-booking is a bookkeeping act that must leave a durable
    // behandlingshistorik record (BFNAR 2013:2 kap 8). Re-detect to capture
    // the dismissed candidate; best-effort, a logging failure must never block
    // a legitimate booking.
    try {
      const dismissed = await detectBookingDuplicate(supabase, companyId, {
        id: txId,
        date: transaction.date,
        amount: transaction.amount,
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
      }, exclude)
      if (dismissed) {
        await appendProcessingHistory({
          companyId,
          correlationId: txId,
          aggregateType: 'BankTransaction',
          aggregateId: txId,
          eventType: 'BankTransactionDuplicateDismissed',
          payload: {
            transaction_id: txId,
            dismissed_transaction_id: dismissed.transaction_id,
            dismissed_journal_entry_id: dismissed.journal_entry_id,
            // Null when the candidate's SEK value could not be established (a
            // rateless foreign sibling); the foreign figures below then carry
            // the durable record instead of a fabricated kr amount.
            amount_ore: dismissed.amount != null ? Math.round(dismissed.amount * 100) : null,
            dismissed_currency: dismissed.currency,
            dismissed_amount_in_currency: dismissed.amount_in_currency,
            entry_date: dismissed.entry_date,
            // Dismissing a candidate whose amounts were never comparable is a
            // materially different decision from dismissing a confirmed
            // same-amount twin; behandlingshistorik has to record which one
            // the user actually made (BFNAR 2013:2 kap 8).
            amount_verified: dismissed.amount_verified,
            unverified_reason: dismissed.unverified_reason,
            via: 'allow_duplicate',
          },
          actor: { type: 'user', id: userId },
          occurredAt: new Date(),
        })
      }
    } catch (logErr) {
      log.warn('failed to record duplicate-dismissal behandlingshistorik', logErr)
    }
  }

  const isBusiness = category !== 'private'

  const { data: settings } = await supabase
    .from('company_settings').select('entity_type, fiscal_year_start_month').eq('company_id', companyId).single()

  const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'
  const fiscalYearStartMonth = settings?.fiscal_year_start_month ?? 1

  let mappingResult = buildMappingResultFromCategory(
    category, transaction as Transaction, isBusiness, entityType, vatTreatment, vatAmount
  )
  const settlementAccount = await resolveSettlementAccount(
    supabase,
    companyId,
    transaction.cash_account_id,
    log,
    transaction.currency,
  )
  mappingResult = applySettlementAccount(mappingResult, settlementAccount)
  // Re-validated here (not only at staging): the account can be deactivated
  // between MCP staging and the user's approval, and the posted entry must
  // never land on an account the chart no longer offers.
  if (accountOverride) {
    if (!isBusiness) {
      return { error: 'account_override kan inte kombineras med category "private".', status: 400 }
    }
    try {
      mappingResult = await applyAccountOverride(
        supabase, companyId, accountOverride, transaction.amount, mappingResult,
        // Explicit VAT intent: a stated treatment or an underlag vat_amount.
        // Without it the override books gross (see applyAccountOverride).
        vatTreatment != null || vatAmount != null,
      )
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'account_override failed', status: 400 }
    }
  }
  // Dimensions PR7: tag the business lines of the generated verifikat.
  if (dimensions && Object.keys(dimensions).length > 0) {
    mappingResult.dimensions = dimensions
  }

  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return { error: `No account mapping for category "${category}" with entity type "${entityType}".`, status: 400 }
  }

  await ensureFiscalPeriod(supabase, userId, companyId, transaction.date, fiscalYearStartMonth)

  let journalEntryId: string | null = null
  try {
    const journalEntry = await createTransactionJournalEntry(
      supabase, companyId, userId, transaction as Transaction, mappingResult, notes,
    )
    if (journalEntry) journalEntryId = journalEntry.id
  } catch (err) {
    if (isBookkeepingError(err)) throw err
    log.error('Failed to create journal entry:', err)
    return { error: err instanceof Error ? err.message : 'Failed to create journal entry', status: 500 }
  }

  const updateQuery = supabase
    .from('transactions')
    .update({
      is_business: isBusiness,
      category,
      is_ignored: false,
      journal_entry_id: journalEntryId,
    })
    .eq('id', txId)
    .eq('company_id', companyId)

  const guardedUpdate = transaction.journal_entry_id
    ? updateQuery.eq('journal_entry_id', transaction.journal_entry_id)
    : updateQuery.is('journal_entry_id', null)

  const { data: updateResult, error: updateError } = await guardedUpdate.select('*')

  if (updateError) {
    log.error('Failed to update transaction:', updateError)
    if (journalEntryId) {
      await reverseOrphanedJournalEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
      )
    }
    const structured = getStructuredError(updateError)
    return structured.code === 'TX_CATEGORIZE_IGNORED_CONFLICT'
      ? { error: structured.message_sv, status: 409 }
      : { error: 'Failed to update transaction', status: 500 }
  }

  if (!updateResult || updateResult.length === 0) {
    if (journalEntryId) {
      await reverseOrphanedJournalEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
      )
    }
    return { error: 'Transaction was categorized by another request.', status: 409 }
  }

  const updatedTransaction = updateResult[0] as Transaction

  // Propagate the underlag from matched invoice-inbox items onto the new
  // verifikation and stamp them consumed (BFL 7 kap): shared with the other
  // booking paths, see lib/transactions/inbox-underlag.ts. Best-effort: the
  // verifikation is already posted, so a failure is logged, never fatal.
  if (journalEntryId) {
    await propagateUnderlagForBookedTransaction(supabase, companyId, txId, journalEntryId)
  }

  try {
    await upsertCounterpartyTemplate(
      supabase, companyId, transaction as Transaction, mappingResult, 'user_approved'
    )
  } catch { /* non-critical */ }

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

  return { data: { journal_entry_id: journalEntryId, category } }
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

  for (const itemId of item_ids) {
    const { data: item, error: itemError } = await supabase
      .from('invoice_inbox_items')
      .select('id, status, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id, channel_context')
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

    let result: CategorizeCoreResult
    try {
      result = await categorizeMatchedTransaction(
        supabase,
        userId,
        companyId,
        item.matched_transaction_id as string,
        { category, vatTreatment: vat_treatment, vatAmount: vat_amount, notes: itemNotes, allowDuplicate: allow_duplicate, dimensions },
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
        result.status === 404 ? 'transaction_not_found'
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
  }

  return { booked, skipped }
}
