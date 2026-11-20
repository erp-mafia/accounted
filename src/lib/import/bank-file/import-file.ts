/**
 * Importing a bank file as one service: every door gets the same effects.
 * Behind the dashboard's /api/import/bank-file/execute route, which sends the
 * rows it parsed and previewed, and the v1 POST /imports/bank, which receives
 * the file itself. What differs is the door's own: parsing, the answer, and
 * that a person chooses a ledger where an API caller has no choice to make
 * (chooseBankFileLedger).
 *
 *   - The rows bind to the ledger decided for them, or to the cash account the
 *     file names (crm#1204): elsewhere the dedup account guard rightly sees
 *     another account, and every row the bank feed already holds comes in again.
 *   - A file covering a period a completed SIE import booked is matched
 *     against the imported verifikat, never auto-booked: CSV is the only way a
 *     migrator gets deep history (PSD2 windows stop at about 90 days), so this
 *     is the primary path of the Fortnox/SIE migrator journey. The sweep after
 *     it links what it can and leaves the rest as suggestions.
 *   - An import where every row failed reads failed, with the reason on the
 *     record, and gets no arrival. Rows the parser could not read stay on the
 *     record too: a lost bank row is a hole in the books.
 *   - transaction.synced fires for the rows that entered.
 *
 * Nothing here books anything by itself: rows land in `transactions`, the
 * underlag for a verifikation.
 */
import type { IngestOptions, IngestResult } from '@/types'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { findCardCashAccount } from '@/lib/cash-accounts/load-card-ledgers'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import { loadFileAccountMatch, type FileAccountMatch } from '@/lib/cash-accounts/file-account'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { ArrivalActor, ArrivalOriginalRef } from '@/lib/intake/arrivals'
import type { OperationContext } from '@/lib/operations/types'
import { runUnattendedReconciliationSweep, toSweepSummary } from '@/lib/reconciliation/unattended-sweep'
import { announceSyncedTransactions } from '@/lib/transactions/announce-synced'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { recordBankFileArrival } from './arrival'
import { dominantCurrency } from './currency-summary'
import { toRawTransaction } from './parser'
import type { BankFileAccountIdentity, BankFileFormatId, BankFileParseIssue, ParsedBankTransaction } from './types'
import { whereSieImportInPlace } from '@/lib/bookkeeping/sie-import-in-place'

export interface BankFileRefusal {
  ok: false
  code: string
  details?: Record<string, unknown>
  messageSv?: string
  messageEn?: string
}

/**
 * The ledger a person's import settles on, checked before anything is written
 * so a refusal leaves nothing behind. It is the one they picked, or the one
 * the file's own account already sits on when they picked none. `ledger`
 * undefined: a file naming no known account, with no pick, imports unbound.
 *
 * The wizard offers any active 19xx chart account, but a row only binds to a
 * cash_accounts row (ingestTransactions looks the ledger up and tolerates a
 * miss), so a picked ledger with no cash account was silently dropped: every
 * row stayed unbound and the booking dialog fell back to 1930. The manual
 * cash account is found or created here. A company card is imported to its
 * own liability ledger: the card already exists (the import never creates
 * one), so it is checked and skips the bank path. Its rows arrive with the
 * stored sign: the wizard flips a statement that prints purchases as plus
 * before the preview, so what was shown is what lands.
 */
export async function chooseBankFileLedger(
  ctx: OperationContext,
  input: {
    transactions: ParsedBankTransaction[]
    /** The statement's own account, as the file states it. */
    account?: BankFileAccountIdentity | null
    /** The ledger the person picked. */
    settlementAccount?: string
  },
): Promise<{ ok: true; ledger: string | undefined } | BankFileRefusal> {
  const { supabase, companyId, log } = ctx
  const currency = dominantCurrency(input.transactions)
  let ledger = input.settlementAccount

  if (input.account) {
    let match: FileAccountMatch | null
    try {
      match = await loadFileAccountMatch(supabase, companyId, input.account, currency)
    } catch (err) {
      log.error('bank file account match failed', err as Error)
      return {
        ok: false,
        code: 'BANK_FILE_EXECUTE_FAILED',
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      }
    }
    if (match && ledger === undefined) {
      ledger = match.ledger_account
    } else if (match && typeof ledger === 'string' && !match.ledger_accounts.includes(ledger)) {
      return {
        ok: false,
        code: 'BANK_FILE_ACCOUNT_MISMATCH',
        details: { account: match.ledger_account, selected: ledger },
        messageSv:
          `Filen gäller bankkontot som finns på ${match.ledger_account}, inte ${ledger}. ` +
          `Importera den till ${match.ledger_account}, så känns rader som redan hämtats från banken igen. ` +
          'Ska bankkontot bokföras på ett annat konto? Byt under Inställningar > Kopplingar > Bank > Välj konton. Inget importerades.',
        messageEn:
          `This file is for the bank account set up on ${match.ledger_account}, not ${ledger}. ` +
          `Import it to ${match.ledger_account} so rows already fetched from the bank are recognized. ` +
          'To book the bank account on another ledger account, change it under Settings > Connections > Bank > Choose accounts. Nothing was imported.',
      }
    }
  }

  if (ledger === undefined) return { ok: true, ledger }

  if (typeof ledger === 'string' && isCardLedgerAccount(ledger)) {
    let card: Awaited<ReturnType<typeof findCardCashAccount>>
    try {
      card = await findCardCashAccount(supabase, companyId, ledger)
    } catch (err) {
      log.error('card settlement account lookup failed', err as Error, { settlementAccount: ledger })
      return { ok: false, code: 'BANK_FILE_EXECUTE_FAILED', details: { reason: getUserErrorMessage(err) } }
    }
    // A card-shaped ledger that is no card of the company (2890 as a
    // catch-all debt) is never a place to import a statement to.
    if (!card) return { ok: false, code: 'BANK_FILE_INVALID_SETTLEMENT_ACCOUNT', details: { account: ledger } }
    if (!card.enabled || card.currency.toUpperCase() !== currency.toUpperCase()) {
      return {
        ok: false,
        code: 'BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE',
        details: { account: ledger, reason: card.enabled ? 'currency_mismatch' : 'disabled' },
      }
    }
    return { ok: true, ledger }
  }

  if (!isCashLedger(ledger)) return { ok: false, code: 'BANK_FILE_INVALID_SETTLEMENT_ACCOUNT' }
  // The ledger must be an active class 19 account in this company's own
  // chart, the same set the wizard offers: a cash account on a ledger the
  // chart does not know would strand every row at booking time.
  const { data: chartRow, error: chartError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('account_number', ledger)
    .eq('is_active', true)
    .maybeSingle()
  if (chartError) {
    log.error('settlement account chart lookup failed', chartError, { settlementAccount: ledger })
    return { ok: false, code: 'BANK_FILE_EXECUTE_FAILED', details: { reason: getUserErrorMessage(chartError) } }
  }
  if (!chartRow) return { ok: false, code: 'BANK_FILE_INVALID_SETTLEMENT_ACCOUNT', details: { account: ledger } }

  // One file is one physical account, so its rows share that account's
  // currency. Wise and camt.053 files can still carry a few rows in another
  // currency; the account is denominated in the one most rows use, exactly as
  // ingest binds every row of a batch to one account.
  try {
    // Named after the ledger, not the currency: two manual accounts in the
    // same currency must stay distinguishable in the account pickers.
    await ensureManualCashAccount(supabase, companyId, ledger, currency, `Bankkonto ${ledger}`)
  } catch (err) {
    log.error('settlement cash account unavailable', err as Error, { settlementAccount: ledger, currency })
    return {
      ok: false,
      code: 'BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE',
      details: { account: ledger, reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
  return { ok: true, ledger }
}

export interface ImportBankFileInput {
  transactions: ParsedBankTransaction[]
  format: BankFileFormatId
  filename: string
  fileHash: string
  /**
   * The ledger the rows settle on, already decided by the door. Absent: the
   * cash account `account` names, and unbound when it names none. A match
   * just binds: an API caller chose nothing that could be refused.
   */
  settlementAccount?: string
  /** The statement's own account, as the file states it. */
  account?: BankFileAccountIdentity | null
  /** A viewer's rows land raw: no matching, no categorizing, no sweep. */
  rawInsertOnly?: boolean
  /** Rows of this file the parser could not read, for a door whose caller saw no preview. */
  unreadRows?: BankFileParseIssue[]
  /** How the file came in, for its arrival. */
  arrival: {
    fetchedBy: ArrivalActor
    via: 'app' | 'partner_api'
    /** Keep the file as it came, for a door that holds it now; else the object stored at parse is read back. */
    keepOriginal?: () => Promise<ArrivalOriginalRef | null>
  }
}

export interface BankFileImportResult {
  importId: string
  ingest: IngestResult
}

export async function importBankFile(
  ctx: OperationContext,
  input: ImportBankFileInput,
): Promise<{ ok: true; data: BankFileImportResult } | BankFileRefusal> {
  const { supabase, companyId, userId, log } = ctx
  const { transactions, format, filename, fileHash } = input
  const dates = transactions.map((t) => t.date).sort()
  const dateFrom = dates[0] || undefined
  const dateTo = dates[dates.length - 1] || undefined

  try {
    const settlementAccount = input.settlementAccount
      ?? (await loadFileAccountMatch(supabase, companyId, input.account, dominantCurrency(transactions)))?.ledger_account

    const { data: importRecord, error: importError } = await supabase
      .from('bank_file_imports')
      .upsert({
        user_id: userId,
        company_id: companyId,
        filename,
        file_hash: fileHash,
        file_format: format,
        transaction_count: transactions.length,
        status: 'processing',
        date_from: dateFrom ?? null,
        date_to: dateTo ?? null,
      }, { onConflict: 'company_id,file_hash' })
      .select('id')
      .single()

    if (importError || !importRecord) {
      log.error('failed to create bank_file_imports record', importError ?? new Error('no record returned'))
      return {
        ok: false,
        code: 'BANK_FILE_IMPORT_RECORD_FAILED',
        details: { reason: importError ? getUserErrorMessage(importError) : 'unknown' },
      }
    }
    const importId = importRecord.id as string

    let sieOverlap: { id: string } | null = null
    if (dateFrom) {
      const { data } = await whereSieImportInPlace(
        supabase
          .from('sie_imports')
          .select('id')
          .eq('company_id', companyId),
      )
        .gte('fiscal_year_end', dateFrom)
        .limit(1)
        .maybeSingle()
      sieOverlap = data ?? null
    }

    const ingestOptions: IngestOptions = {
      // Stamp every inserted row with this batch so the owner/admin
      // "undo this import" action can scope its bulk delete exactly.
      bankFileImportId: importId,
    }
    if (settlementAccount) ingestOptions.settlementAccount = settlementAccount
    if (input.rawInsertOnly) ingestOptions.rawInsertOnly = true
    if (sieOverlap) ingestOptions.skipAutoCategorization = true
    const ingest = await ingestTransactions(
      supabase, companyId, userId, transactions.map((tx, index) => toRawTransaction(tx, format, index)), ingestOptions,
    )

    if (ingest.errors > 0 && ingest.first_error) {
      log.error('bank file ingest reported insert errors', new Error(ingest.first_error.message), {
        errorCount: ingest.errors,
        code: ingest.first_error.code,
        details: ingest.first_error.details,
        hint: ingest.first_error.hint,
      })
    }

    const everyRowFailed = ingest.errors > 0 && ingest.imported === 0
    const ingestProblem = ingest.errors > 0
      ? ingest.first_error
        ? `${ingest.errors} fel: ${ingest.first_error.message}${ingest.first_error.details ? ` (${ingest.first_error.details})` : ''}`
        : `${ingest.errors} transactions failed to import`
      : null
    const unread = input.unreadRows ?? []
    const unreadProblem = unread.length > 0
      ? `${unread.length} rader kunde inte läsas och importerades inte: rad ${unread.map((issue) => issue.row).join(', ')}`
      : null
    const errorMessage = [ingestProblem, unreadProblem].filter(Boolean).join('. ') || null

    const { error: completionError } = await supabase
      .from('bank_file_imports')
      .update({
        imported_count: ingest.imported,
        duplicate_count: ingest.duplicates,
        matched_count: ingest.auto_matched_invoices,
        status: everyRowFailed ? 'failed' : 'completed',
        error_message: errorMessage,
      })
      .eq('id', importId)
      .eq('company_id', companyId)
    // The rows are in, so a failed status write fails nothing. It must not be
    // silent either: an unchecked error here once hid a phantom column, and
    // the row stayed `processing` with zeroed counters for ever.
    if (completionError) log.warn('failed to finalize bank_file_imports record', { importId, error: completionError.message })

    // No sweep for a raw insert: it updates transactions, which a viewer cannot.
    if (sieOverlap && ingest.imported > 0 && !input.rawInsertOnly) {
      await sweepOverlap(ctx, importId, dateFrom, dateTo)
    }

    if (ingest.imported > 0 && ingest.transaction_ids.length > 0) {
      try {
        await announceSyncedTransactions(supabase, {
          companyId, userId, transactionIds: ingest.transaction_ids, log, context: { importId },
        })
      } catch (err) {
        log.warn('transaction.synced event emission failed', err as Error)
      }
    }

    if (!everyRowFailed) {
      await recordBankFileArrival(supabase, {
        companyId,
        importId,
        fileHash,
        filename,
        format,
        transactionCount: transactions.length,
        importedCount: ingest.imported,
        dateFrom: dateFrom ?? null,
        dateTo: dateTo ?? null,
        fetchedBy: input.arrival.fetchedBy,
        via: input.arrival.via,
        original: await input.arrival.keepOriginal?.(),
      })
    }

    return { ok: true, data: { importId, ingest } }
  } catch (err) {
    log.error('bank file execute failed', err as Error)
    return {
      ok: false,
      code: 'BANK_FILE_EXECUTE_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

/**
 * The reconciliation sweep after a file that overlaps a SIE import: one scoped
 * run per enabled cash account. At 0.9 and above it links, the 0.75-0.89 band
 * persists as reviewable suggestions. Non-critical: rows stay in "Att bokföra"
 * for manual matching.
 */
async function sweepOverlap(ctx: OperationContext, importId: string, dateFrom?: string, dateTo?: string): Promise<void> {
  const { supabase, companyId, userId, log } = ctx
  try {
    const sweep = await runUnattendedReconciliationSweep(supabase, companyId, userId, { dateFrom, dateTo })
    const { error: stampError } = await supabase
      .from('bank_file_imports')
      .update({ sie_sweep: toSweepSummary(sweep, { dateFrom, dateTo }) })
      .eq('id', importId)
      .eq('company_id', companyId)
    // The links and suggestions are already written; only the UI summary is
    // missing. Say so instead of letting the sweep look unrun.
    if (stampError) log.warn('failed to stamp sie_sweep summary on bank_file_imports', stampError)
    if (sweep.applied > 0 || sweep.suggested > 0) {
      log.info('post-import SIE reconciliation sweep', {
        applied: sweep.applied, suggested: sweep.suggested, unmatched: sweep.unmatched,
      })
    }
  } catch (err) {
    log.warn('post-import SIE reconciliation sweep failed', err as Error)
  }
}
