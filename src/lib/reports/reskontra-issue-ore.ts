/**
 * The öresavrundning an invoice's issue verifikat booked, in the
 * kundreskontra.
 *
 * An invoice with öresavrundning asks for its rounded "Att betala" (999,75 kr
 * invoiced as 1 000 kr), and its issue verifikat books that claim: 1510 at
 * 1 000 and the 0,25 on 3740 (issueOreRoundingDelta). The invoice row keeps
 * the exact total, so a reskontra read off `total - paid_amount` would say
 * 999,75 while 1510 says 1 000, and the tie-out to 1510 (the bokslut check
 * "Kundreskontran stämmer inte mot konto 1510") would show the öre as a
 * difference. The reskontra therefore counts the öre the issue booked while
 * the customer's part is open: a part payment clears its own amount and the
 * settlement of the rest clears what 151x carries, öre and all
 * (bookedOreRounding in every payment door), after which nothing is added.
 *
 * Invoices issued before, and imported ones booked at the exact total, have
 * no öre on their issue verifikat and read as they always did. Which ones
 * booked it is a fact of their own verifikat (fetchIssueBookedOre); only a SEK
 * document with öre in its total can have one, so only those are read, and
 * the invoices a credit note's verifikat paid (creditNoteCreditUsed reads
 * theirs).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { invoiceCustomerOutstanding, invoiceCustomerShare } from '@/lib/bookkeeping/customer-share'
import { hasOreToRound } from '@/lib/bookkeeping/invoice-rounding'
import { fetchIssueBookedOre } from '@/lib/bookkeeping/ledger-carried-sek'
import { roundOre } from '@/lib/money'
import type { CreditNoteLink } from './credit-note-settlement'

/** The fields of a reskontra row the rule reads, as get_ar_ledger_invoices carries them. */
export interface IssueOreRow {
  id: string
  currency: string | null
  total: number | string | null
  deduction_total: number | string | null
  deduction_reclaimed_total?: number | string | null
  journal_entry_id: string | null
  credit_links?: readonly CreditNoteLink[] | null
}

/**
 * The öre each row's issue verifikat booked (issueBookedOre), keyed by
 * invoice id, beside that of every SEK invoice a credit note's verifikat paid.
 * Rows that booked none are absent. Throws on a read error.
 */
export async function fetchReskontraIssueOre(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  rows: readonly IssueOreRow[],
): Promise<Map<string, number>> {
  const ids = rows.filter((row) => row.journal_entry_id && hasOreToRound(row)).map((row) => row.id)
  for (const row of rows) {
    if (!isCreditNoteDocument(row) || !isKronorCurrency(row.currency)) continue
    for (const link of row.credit_links ?? []) {
      if (isKronorCurrency(link.currency)) ids.push(link.invoice_id)
    }
  }
  return ids.length === 0 ? new Map() : fetchIssueBookedOre(supabase, companyId, ids)
}

/**
 * A row's reskontra figure with the öre its issue booked, while the
 * customer's part is open. `receivable` is the figure the reskontra rules
 * give (Skatteverket's payouts taken off), `outstanding` the row's open
 * amount before them (its total less what was paid, live or as of a date),
 * `ore` its fetchReskontraIssueOre entry. A kreditfaktura's figures are
 * negative, and so is the öre it mirrored.
 */
export function withIssueOre(
  receivable: number,
  outstanding: number,
  row: Pick<IssueOreRow, 'total' | 'deduction_total' | 'deduction_reclaimed_total'>,
  ore: number | undefined,
): number {
  if (!ore) return receivable
  const facts = {
    total: Number(row.total) || 0,
    deduction_total: Number(row.deduction_total) || 0,
    deduction_reclaimed_total: Number(row.deduction_reclaimed_total) || 0,
  }
  const share = invoiceCustomerShare(facts)
  const customerOpen = invoiceCustomerOutstanding(facts, roundOre(facts.total - outstanding))
  // Settled (or paid past it): the settlement cleared what 151x carried.
  if (customerOpen === 0 || Math.sign(customerOpen) !== Math.sign(share)) return receivable
  return roundOre(receivable + ore)
}

/**
 * The total a reskontra row shows: what the issue verifikat put on 1510 and
 * 1513 (the rounded "Att betala" before any deduction when it booked the
 * öre), so the paid column, total less outstanding, stays what was paid.
 */
export function reskontraShownTotal(row: Pick<IssueOreRow, 'total'>, ore: number | undefined): number {
  return roundOre((Number(row.total) || 0) + (ore ?? 0))
}
