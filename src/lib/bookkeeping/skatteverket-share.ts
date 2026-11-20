/**
 * Skatteverket's share of a ROT/RUT invoice: ONE definition of what is still
 * open on 1513.
 *
 * Under fakturamodellen the deduction is a fordran on Skatteverket carried on
 * 1513, never on the customer (customer-share.ts). Once the buyer has paid
 * their share the invoice is 'paid', but the claim stays on 1513 until the
 * payout voucher of its begäran clears it
 * (rot_rut_payout_requests.settlement_journal_entry_id, booked by
 * rot-rut-settle.ts, which writes nothing to the invoice). The kundreskontra
 * and its 1510 + 1513 reconciliation read the open share from here, so a paid
 * invoice awaiting Skatteverket is still listed and a settled one is not.
 *
 * What a payout cleared on one invoice: a begäran settled in full ('paid')
 * cleared the whole deduction not reclaimed, öre included (the settle path
 * books the öre the whole-kronor request leaves, rot-rut-receivable.ts); a
 * partly paid one cleared the item's decided_amount and leaves the refused
 * rest on 1513 until a rot_rut_reclaim moves it onto the customer
 * (deduction_reclaimed_total).
 */
import { roundOre } from '@/lib/money'

/** The invoice header fields the Skatteverket-share arithmetic reads. */
export interface SkatteverketShareInvoice {
  /** ROT/RUT skattereduktion, a positive magnitude. Null and 0 mean none. */
  deduction_total?: number | string | null
  /** The refused part booked back onto the customer (rot_rut_reclaim). */
  deduction_reclaimed_total?: number | string | null
}

/** One begäran item of the invoice, on a begäran with a settlement voucher. */
export interface SettledPayoutItem {
  /** The begäran's status: 'paid' or 'partially_paid' once settled. */
  request_status: string
  /** Godkänt belopp for this invoice; null until a beslut records it. */
  decided_amount: number | string | null
}

function hasDeduction(invoice: SkatteverketShareInvoice): boolean {
  // `> 0` also catches NaN, as in customer-share.ts.
  return Number(invoice.deduction_total) > 0
}

/** The claim on Skatteverket before any payout: the deduction not reclaimed. */
function claimBeforePayouts(invoice: SkatteverketShareInvoice): number {
  if (!hasDeduction(invoice)) return 0
  const reclaimed = Number(invoice.deduction_reclaimed_total) || 0
  return Math.max(0, roundOre(Number(invoice.deduction_total) - reclaimed))
}

/**
 * The part of the invoice's deduction Skatteverket has paid out, from the
 * items of its settled begäran. Never more than the claim: a re-request after
 * a partial payout is settled 'paid' for the rest only.
 */
export function skatteverketSettled(
  invoice: SkatteverketShareInvoice,
  items: readonly SettledPayoutItem[]
): number {
  const claim = claimBeforePayouts(invoice)
  let settled = 0
  for (const item of items) {
    settled += item.request_status === 'paid' ? claim : Number(item.decided_amount) || 0
  }
  return Math.min(claim, roundOre(settled))
}

/** What Skatteverket still owes on the invoice after `settled` was paid out. */
export function openSkatteverketShare(invoice: SkatteverketShareInvoice, settled: number): number {
  return Math.max(0, roundOre(claimBeforePayouts(invoice) - settled))
}

/**
 * An invoice's outstanding (total - paid_amount, live or as of a date) less
 * what Skatteverket has paid out on it: what the invoice still carries on 1510
 * and 1513 together. Rows with nothing settled are returned untouched, so an
 * invoice without a deduction reads exactly as before.
 */
export function outstandingLessPayouts(outstanding: number, settled: number | undefined): number {
  if (!settled) return outstanding
  return roundOre(outstanding - settled)
}

/**
 * The live reskontra rule. A paid invoice with a deduction owes nothing more
 * from the customer: what it still carries is Skatteverket's open share,
 * whatever paid_amount says. Every other invoice is its outstanding less the
 * payouts.
 */
export function liveReceivableOutstanding(
  invoice: SkatteverketShareInvoice & { status?: string | null },
  outstanding: number,
  settled: number | undefined
): number {
  if (invoice.status === 'paid' && hasDeduction(invoice)) {
    return openSkatteverketShare(invoice, settled ?? 0)
  }
  return outstandingLessPayouts(outstanding, settled)
}

/**
 * One begäran item of a ROT/RUT invoice, on a begäran with a settlement
 * voucher, as get_ar_ledger_invoices attaches them to the invoice
 * (lib/reports/ar-ledger-invoices.ts), in id order.
 */
export interface PayoutItemFact {
  request_status: string
  decided_amount: number | string | null
  /** The settlement voucher's date; null when it cannot be read. */
  settlement_entry_date: string | null
}

/**
 * What Skatteverket has paid out per invoice, keyed by invoice id, from the
 * begäran items each invoice carries. Invoices without a deduction are
 * ignored. With an `asOfDate` only the payouts whose voucher is dated on or
 * before it count.
 */
export function skatteverketSettledByInvoice(
  invoices: readonly (SkatteverketShareInvoice & {
    id: string
    payout_items?: readonly PayoutItemFact[] | null
  })[],
  asOfDate?: string
): Map<string, number> {
  const settled = new Map<string, number>()
  for (const invoice of invoices) {
    if (!hasDeduction(invoice)) continue
    const items: SettledPayoutItem[] = []
    for (const item of invoice.payout_items ?? []) {
      if (asOfDate) {
        const entryDate = item.settlement_entry_date
        if (!entryDate || entryDate > asOfDate) continue
      }
      items.push({ request_status: item.request_status, decided_amount: item.decided_amount })
    }
    if (items.length > 0) settled.set(invoice.id, skatteverketSettled(invoice, items))
  }
  return settled
}
