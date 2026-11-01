/**
 * Whether a document plainly belongs to another purchase than the bank row
 * it is about to be linked to: the check the doors that pair a document with
 * a transaction run before the pairing (lib/transactions/document-attach.ts,
 * and lib/documents/inbox-match.ts through documentFitGate, passed in: the
 * comparison lives here, in the inbox block, beside the matchers it shares
 * its tolerances with).
 *
 * crm#1479: an invoice of 90 EUR from one seller was dropped on a bank row of
 * 202.78 kr from another, and became underlag on that row's verifikat when it
 * was booked, where BFL keeps it. Nothing in the pairing looked at the two
 * sides.
 *
 * A mismatch is the document asking for MORE than the row paid, beyond the
 * converted-amount tolerance the bank matchers use, AND no name it carries
 * agreeing with the row's texts (the bank matchers' NAME_AGREEMENT). Either
 * alone is everyday: one invoice paid in parts or several payments on one
 * statement (amount), a bank text that never names the seller ("Kortköp",
 * "Utlägg", a person's name). A document asking for LESS is never a mismatch:
 * one row may carry several documents. Measured over every pairing in
 * production on 2026-10-27, both together still held for 74 of 5 667 (most of
 * them one document covering several rows), so a mismatch is not refused
 * outright: the caller states that it belongs anyway (a reason from an agent,
 * a confirmation from a person) and the pairing goes ahead.
 *
 * No verdict (null) whenever a side cannot be read: a document that is not an
 * invoice, receipt or credit note, no amount, no names, no row text, or no
 * rate for a currency the row does not carry. The automatic matchers cannot
 * propose such a pair at all: match on arrival requires the amounts to agree
 * (./decide.ts) and the receipt hunt's confidence stays below its
 * floor once the amount disagrees (lib/documents/core-receipt-matcher.ts
 * calculateMatchConfidence).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isKronorCurrency, resolveSekAmountOrNull, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import { formatCurrency } from '@/lib/utils'
import { calculateMerchantSimilarity, CONVERTED_AMOUNT_TOLERANCE_PERCENT } from '@/lib/documents/core-receipt-matcher'
import { loadDocumentReading } from '@/lib/documents/reading/load'
import { NAME_AGREEMENT } from './decide'
import { bankMatchFacts, type BankMatchFacts } from './facts'

/** The bank row as the check reads it. */
export interface FitRow {
  amount: number
  currency?: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
  instructed_amount?: number | null
  instructed_currency?: string | null
  merchant_name?: string | null
  description?: string | null
  original_description?: string | null
  date?: string | null
}

/** Both sides of a mismatch, for the refusal and the person who decides. */
export interface DocumentRowMismatch {
  document_vendor: string
  document_amount: number
  document_currency: string
  /** The document's amount in kronor, when it had to be converted to compare. */
  document_amount_sek: number | null
  transaction_text: string
  transaction_amount: number
  transaction_currency: string
}

function rowTexts(row: FitRow): string[] {
  return [row.merchant_name, row.description, row.original_description].filter(
    (t): t is string => typeof t === 'string' && t.trim() !== '',
  )
}

/**
 * The two amounts in one currency: the document's own and the row's, or the
 * row's instructed (original) amount when it was paid in the document's
 * currency, or both in kronor. Null when they cannot be compared.
 */
function comparableAmounts(
  facts: BankMatchFacts,
  row: FitRow,
  documentSek: number | null,
): { document: number; row: number; documentSek: number | null } | null {
  const rowCurrency = (row.currency ?? 'SEK').toUpperCase()
  if (facts.currency === rowCurrency) return { document: facts.amount, row: Math.abs(row.amount), documentSek: null }
  const instructed = (row.instructed_currency ?? '').toUpperCase()
  if (instructed === facts.currency && row.instructed_amount != null) {
    return { document: facts.amount, row: Math.abs(row.instructed_amount), documentSek: null }
  }
  if (documentSek == null) return null
  const rowSek = resolveSekAmountOrNull(row.amount, row.amount_sek, rowCurrency, row.exchange_rate)
  if (rowSek == null) return null
  return { document: documentSek, row: Math.abs(rowSek), documentSek }
}

/**
 * The verdict, pure: `documentSek` is the document's amount in kronor (itself
 * for a kronor document, through a rate otherwise), or null without a rate.
 */
export function documentRowMismatch(
  facts: BankMatchFacts | null,
  row: FitRow,
  documentSek: number | null,
): DocumentRowMismatch | null {
  if (!facts || facts.names.length === 0) return null
  const texts = rowTexts(row)
  if (texts.length === 0) return null
  const amounts = comparableAmounts(facts, row, documentSek)
  if (!amounts || amounts.row === 0) return null
  if (amounts.document <= amounts.row * (1 + CONVERTED_AMOUNT_TOLERANCE_PERCENT)) return null
  const nameAgrees = facts.names.some((name) => texts.some((text) => calculateMerchantSimilarity(name, text) >= NAME_AGREEMENT))
  if (nameAgrees) return null
  return {
    document_vendor: facts.names[0],
    document_amount: facts.amount,
    document_currency: facts.currency,
    document_amount_sek: amounts.documentSek,
    transaction_text: texts[0],
    transaction_amount: row.amount,
    transaction_currency: (row.currency ?? 'SEK').toUpperCase(),
  }
}

const log = createLogger('documents/bank-match/fit')

export interface DocumentFitDeps {
  /** Riksbanken's rate for a currency on a day, or null. Defaults to fetchExchangeRate with the shared cache. */
  rateFor?: (currency: string, isoDate: string) => Promise<number | null>
}

/**
 * Read the document (its one reading) and decide. Never throws: a read that
 * fails is no verdict, and the pairing is judged as it was before this check.
 */
export async function findDocumentRowMismatch(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  row: FitRow,
  deps: DocumentFitDeps = {},
): Promise<DocumentRowMismatch | null> {
  try {
    const reading = await loadDocumentReading(supabase, companyId, { documentId })
    const today = todayIsoStockholm()
    const facts = bankMatchFacts(reading, null, today)
    if (!facts) return null
    let documentSek: number | null = isKronorCurrency(facts.currency) ? facts.amount : null
    const rowCurrency = (row.currency ?? 'SEK').toUpperCase()
    const needsRate =
      documentSek === null &&
      facts.currency !== rowCurrency &&
      (row.instructed_currency ?? '').toUpperCase() !== facts.currency
    if (needsRate) {
      const rateFor =
        deps.rateFor ??
        (async (currency: string, isoDate: string) => {
          const rate = await fetchExchangeRate(currency, new Date(`${isoDate}T12:00:00Z`), supabase)
          return rate && rate.rate > 0 ? rate.rate : null
        })
      const rate = await rateFor(facts.currency, facts.issueDate ?? row.date ?? today)
      documentSek = rate != null ? sekOfForeign(facts.amount, rate) : null
    }
    return documentRowMismatch(facts, row, documentSek)
  } catch (err) {
    // The pairing is judged as it was before this check; the trace says why.
    log.warn('document fit check skipped: the document could not be read', {
      document_id: documentId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * The refusal in Swedish, naming both sides so the person or agent can tell
 * at once whether the document belongs here.
 */
export function formatMismatchSv(mismatch: DocumentRowMismatch): string {
  const documentAmount = formatCurrency(mismatch.document_amount, mismatch.document_currency)
  const inKronor =
    mismatch.document_amount_sek != null ? ` (cirka ${formatCurrency(mismatch.document_amount_sek, 'SEK')})` : ''
  const rowAmount = formatCurrency(mismatch.transaction_amount, mismatch.transaction_currency)
  return (
    `Underlaget verkar höra till ett annat köp: det är från ${mismatch.document_vendor} på ${documentAmount}${inKronor}, ` +
    `men transaktionen är ${mismatch.transaction_text} på ${rowAmount}. ` +
    'Koppla det bara om det verkligen hör hit, till exempel en faktura som betalas i flera delar.'
  )
}

/** A stated reason that lets a mismatching pairing through: a few words, not a flag. */
export function isMismatchReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 3
}

/** A pairing refused because the document plainly belongs to another purchase. */
export interface DocumentFitRefusal {
  code: 'DOC_ROW_MISMATCH'
  details: Record<string, unknown>
  messageSv: string
}

/**
 * The check a door runs before pairing `documentId` with a bank row: a
 * refusal when the document plainly belongs to another purchase and no
 * reason was stated, else null (a stated reason lets the pairing through).
 * Built by the caller and passed to the pairing, so the kernel's
 * matchInboxItemTransaction needs no import of this block.
 */
export function documentFitGate(
  supabase: SupabaseClient,
  companyId: string,
  mismatchReason: unknown,
  deps: DocumentFitDeps = {},
): (documentId: string, row: FitRow) => Promise<DocumentFitRefusal | null> {
  return async (documentId, row) => {
    const mismatch = await findDocumentRowMismatch(supabase, companyId, documentId, row, deps)
    if (!mismatch) return null
    if (isMismatchReason(mismatchReason)) {
      log.info('document fit: mismatch confirmed by the caller', { document_id: documentId })
      return null
    }
    return { code: 'DOC_ROW_MISMATCH', details: { ...mismatch }, messageSv: formatMismatchSv(mismatch) }
  }
}
