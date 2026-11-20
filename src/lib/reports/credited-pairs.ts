import type { SupabaseClient } from '@supabase/supabase-js'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { documentCurrency } from '@/lib/bookkeeping/ledger-line-amount'
import { roundOre } from '@/lib/money'
import { chunk } from '@/lib/utils'

/**
 * A kreditfaktura set against the invoice it credits (crm#1537 follow-up).
 *
 * Kreditera books the credit note's own verifikat (Cr 1510) and moves the
 * original to 'credited'; 1510 carries both and they net. The kundreskontra
 * keeps both rows so its total matches 1510, but listed one by one a fully
 * credited invoice read as an open, overdue claim beside a negative row: the
 * customer owed nothing on it. Read as a pair, the credit note's open credit
 * is applied to its original's open amount first. A pair that nets to zero
 * leaves neither row open; a partial credit leaves the rest on the original,
 * aged by the original's due date; a credit above what the original still
 * carries (paid before it was credited) stays on the credit note, owed back.
 * The sum of the two rows never changes, so neither do the ledger's totals.
 */

/** Ids per read of the credit notes' originals. */
const CREDIT_NOTE_READ_CHUNK = 200

export interface CreditedPairRow {
  id: string
  currency?: string | null
  exchange_rate?: unknown
}

/**
 * The invoice each credit note credits (invoices.credited_invoice_id), keyed
 * by credit note id. The population read does not carry the link. A failed
 * read answers what it has: the rows are then listed unpaired, as before,
 * and the ledger's figures are the same either way.
 */
export async function fetchCreditedInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
  creditNoteIds: readonly string[],
): Promise<Map<string, string>> {
  const credited = new Map<string, string>()
  try {
    for (const ids of chunk(creditNoteIds, CREDIT_NOTE_READ_CHUNK)) {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, credited_invoice_id')
        .eq('company_id', companyId)
        .in('id', ids)
      if (error) return credited
      for (const row of (data ?? []) as { id: string; credited_invoice_id: string | null }[]) {
        if (row.credited_invoice_id) credited.set(row.id, row.credited_invoice_id)
      }
    }
  } catch {
    // A thrown read degrades the same way as a failed one.
  }
  return credited
}

/**
 * Two rows convert to kronor the same way: the same currency, and for a
 * foreign one the same rate. Only then does moving an amount between them
 * leave the SEK totals as they were.
 */
function sameConversion(a: CreditedPairRow, b: CreditedPairRow): boolean {
  if (documentCurrency(a.currency) !== documentCurrency(b.currency)) return false
  return isKronorCurrency(a.currency) || (Number(a.exchange_rate) || 0) === (Number(b.exchange_rate) || 0)
}

/**
 * Each row's open amount with its credit notes applied to the originals they
 * credit, and the ids the pairing brought to zero (settled by credit, not
 * open). `outstanding` is each row's open amount in its own currency; rows
 * that are not in a pair keep theirs.
 */
export function netCreditedPairs(
  rows: readonly CreditedPairRow[],
  outstanding: ReadonlyMap<string, number>,
  creditedInvoiceOf: ReadonlyMap<string, string>,
): { outstanding: Map<string, number>; settledByCredit: Set<string> } {
  const net = new Map(outstanding)
  const settledByCredit = new Set<string>()
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const note of rows) {
    const originalId = creditedInvoiceOf.get(note.id)
    const original = originalId ? byId.get(originalId) : undefined
    if (!originalId || !original || !sameConversion(original, note)) continue
    const owed = net.get(originalId) ?? 0
    const credit = net.get(note.id) ?? 0
    if (!(owed > 0 && credit < 0)) continue
    const applied = Math.min(owed, -credit)
    const originalLeft = roundOre(owed - applied)
    const creditLeft = roundOre(credit + applied)
    net.set(originalId, originalLeft)
    net.set(note.id, creditLeft)
    if (originalLeft === 0) settledByCredit.add(originalId)
    if (creditLeft === 0) settledByCredit.add(note.id)
  }
  return { outstanding: net, settledByCredit }
}
