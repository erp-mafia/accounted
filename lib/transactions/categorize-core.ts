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
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { detectBookingDuplicate, type BookingDuplicateExclusions } from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import type { Transaction, TransactionCategory, EntityType, VatTreatment } from '@/types'

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
  const { category, vatTreatment, vatAmount, notes, allowDuplicate, dimensions } = opts

  const { data: transaction, error: fetchError } = await supabase
    .from('transactions').select('*').eq('id', txId).eq('company_id', companyId).single()

  if (fetchError || !transaction) {
    return { error: 'Transaction not found: it may have been deleted.', status: 404 }
  }
  if (transaction.journal_entry_id) {
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
        cash_account_id: transaction.cash_account_id ?? null,
      }, exclude)
    } catch (err) {
      log.warn('booking-time duplicate detection failed (continuing)', err)
    }
    if (dup) {
      const amountAbs = roundOre(Math.abs(Number(transaction.amount)))
      const voucher = dup.voucher_label ? `verifikat ${dup.voucher_label}` : 'en befintlig verifikation'
      return {
        error:
          `Möjlig dubblettbokföring: ${voucher} (${dup.entry_date}) bokför redan ${amountAbs} kr på bankkontot. ` +
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
            amount_ore: Math.round(dismissed.amount * 100),
            entry_date: dismissed.entry_date,
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

  const mappingResult = buildMappingResultFromCategory(
    category, transaction as Transaction, isBusiness, entityType, vatTreatment, vatAmount
  )
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

  const { error: updateError } = await supabase
    .from('transactions')
    .update({ is_business: isBusiness, category, journal_entry_id: journalEntryId })
    .eq('id', txId)

  if (updateError) {
    log.error('Failed to update transaction:', updateError)
    return { error: 'Failed to update transaction', status: 500 }
  }

  // Propagate the underlag from a matched invoice-inbox item onto the new
  // verifikation. Without this, BFL 7 kap is violated: a verifikation exists
  // with no underlag attached even though the user explicitly linked an inbox
  // item (with a document) to this transaction. We:
  //   1. find the inbox item(s) where matched_transaction_id = txId
  //   2. for each item with a document_id, set
  //        document_attachments.journal_entry_id = journalEntryId (idempotent)
  //   3. stamp invoice_inbox_items.created_journal_entry_id so the inbox row
  //      visibly moves to "Bearbetade" and shows "Öppna verifikation".
  // Errors are logged but don't fail the commit: the verifikation itself is
  // already posted, and the link can be repaired by re-running this step.
  if (journalEntryId) {
    try {
      const { data: matchedInboxItems } = await supabase
        .from('invoice_inbox_items')
        .select('id, document_id')
        .eq('company_id', companyId)
        .eq('matched_transaction_id', txId)
        .is('created_journal_entry_id', null)
      for (const inbox of (matchedInboxItems ?? []) as Array<{
        id: string
        document_id: string | null
      }>) {
        if (inbox.document_id) {
          try {
            await linkToJournalEntry(supabase, companyId, inbox.document_id, journalEntryId)
          } catch (err) {
            log.error('Failed to link inbox document to journal entry', {
              inbox_item_id: inbox.id,
              document_id: inbox.document_id,
              journal_entry_id: journalEntryId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        const { error: stampError } = await supabase
          .from('invoice_inbox_items')
          .update({ created_journal_entry_id: journalEntryId })
          .eq('id', inbox.id)
          .eq('company_id', companyId)
        if (stampError) {
          log.error('Failed to stamp inbox item created_journal_entry_id', {
            inbox_item_id: inbox.id,
            journal_entry_id: journalEntryId,
            error: stampError.message,
          })
        }
      }
    } catch (err) {
      log.error('Failed to propagate underlag from matched inbox items', err)
    }
  }

  try {
    await upsertCounterpartyTemplate(
      supabase, companyId, transaction as Transaction, mappingResult, 'user_approved'
    )
  } catch { /* non-critical */ }

  await eventBus.emit({
    type: 'transaction.categorized',
    payload: {
      transaction: transaction as Transaction,
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
}

export interface BulkBookInboxResult {
  booked: Array<{ item_id: string; transaction_id: string; journal_entry_id: string | null }>
  skipped: Array<{ item_id: string; reason: string; detail?: string }>
}

/**
 * Book each selected inbox item against its matched bank transaction with one
 * shared category + VAT treatment. Items without a matched transaction, already
 * booked, or already linked to a leverantörsfaktura are skipped: never an
 * error: so one bad underlag never blocks the rest ("Bokför valda hoppar
 * över"). A per-item throw (period locked, accounts not in chart) is caught and
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
  const { item_ids, category, vat_treatment, vat_amount, notes, allow_duplicate } = input

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
      .select('id, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (itemError || !item) {
      skipped.push({ item_id: itemId, reason: 'not_found' })
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

    let result: CategorizeCoreResult
    try {
      result = await categorizeMatchedTransaction(
        supabase,
        userId,
        companyId,
        item.matched_transaction_id as string,
        { category, vatTreatment: vat_treatment, vatAmount: vat_amount, notes, allowDuplicate: allow_duplicate },
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
