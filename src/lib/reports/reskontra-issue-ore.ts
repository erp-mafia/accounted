/**
 * The öresavrundning an invoice's issue verifikat booked, in the
 * kundreskontra (crm#2283).
 *
 * An invoice with öresavrundning asks for its rounded "Att betala" (999,75 kr
 * invoiced as 1 000 kr), and its issue verifikat books that claim: 1510 at
 * 1 000 and the 0,25 on 3740. The invoice row keeps the exact total, so a
 * reskontra read off `total - paid_amount` would say 999,75 while 1510 says
 * 1 000, and the tie-out to 1510 would show the öre as a difference. The
 * reskontra therefore counts the öre the issue booked while the customer's
 * part is open; a settlement of that part clears what 151x carries, öre and
 * all (bookedOreRounding in the payment doors), after which nothing is added.
 *
 * Invoices issued before this, and imported ones booked at the exact total,
 * have no öre on their issue verifikat and read as they always did. Which
 * invoices booked one is a fact of their own verifikat
 * (invoice_issue_receivable_sek, issueBookedOre); only a SEK invoice with öre
 * in its total can have one, so only those are read.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { invoiceCustomerOutstanding } from '@/lib/bookkeeping/customer-share'
import { hasOreToRound } from '@/lib/bookkeeping/invoice-rounding'
import { fetchIssueBookedOre } from '@/lib/bookkeeping/ledger-carried-sek'
import { roundOre } from '@/lib/money'

/** The invoice fields the rule reads, as the reskontra population carries them. */
export interface IssueOreInvoice {
  id: string
  currency: string | null
  total: number | string | null
  deduction_total: number | string | null
  deduction_reclaimed_total?: number | string | null
  journal_entry_id: string | null
}

/** The öre each invoice's issue verifikat booked, keyed by invoice id; invoices that booked none are absent. Throws on a read error. */
export async function issueOreByInvoice(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  invoices: readonly IssueOreInvoice[],
): Promise<Map<string, number>> {
  const candidates = invoices.filter((inv) => inv.journal_entry_id && hasOreToRound(inv)).map((inv) => inv.id)
  return candidates.length === 0 ? new Map() : fetchIssueBookedOre(supabase, companyId, candidates)
}

/**
 * An invoice's reskontra figure with the öre its issue booked, while the
 * customer's part is open. `receivable` is the figure the reskontra rules
 * give (Skatteverket's payouts taken off), `outstanding` the invoice's open
 * amount before them (its total less what was paid, live or as of a date),
 * `ore` its issueOreByInvoice entry.
 */
export function withIssueOre(
  receivable: number,
  outstanding: number,
  invoice: IssueOreInvoice,
  ore: number | undefined,
): number {
  if (!ore) return receivable
  const total = Number(invoice.total) || 0
  const customerOpen = invoiceCustomerOutstanding(
    {
      total,
      deduction_total: Number(invoice.deduction_total) || 0,
      deduction_reclaimed_total: Number(invoice.deduction_reclaimed_total) || 0,
    },
    roundOre(total - outstanding),
  )
  return customerOpen === 0 ? receivable : roundOre(receivable - ore)
}
