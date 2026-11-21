import type { VatSettlementProposal } from '@/lib/reports/vat-settlement'
import { VAT_SETTLEMENT_NET_ACCOUNTS } from '@/lib/reports/vat-declaration'

/**
 * Whether what a partly settled period has left (the proposal's lines with
 * partly_settled) can be booked as a verifikat of its own and then count as
 * part of the period's momsredovisning, not as business the rutor read
 * (#3570). Pure and client-safe: the Moms page reads it.
 *
 * Two things must hold:
 *
 * - The verifikat is dated inside the period: the period's last day, which
 *   entry_date is when entry_date_reason is null. One dated after the period
 *   is outside its ledger, and the period keeps showing the same rest.
 * - Its lines have a momsredovisning shape (momsredovisningShapeOfLines in
 *   src/lib/vat/voucher-vat-impact.ts, not importable from the client). The
 *   rest lines are 26xx, 2650/1650 and 3740 and never a skattekonto line, so
 *   only the net-account shape applies: they need their 2650/1650 line. Output
 *   and input VAT that net to zero (an EU purchase on 2614/2645) have none,
 *   and posted alone they would move ruta 30 and ruta 48.
 *
 * When it is false, the way out is to reverse the momsredovisning and book
 * the period again.
 */
export function partlySettledRestBooksAlone(
  proposal: Pick<VatSettlementProposal, 'lines' | 'entry_date_reason'>,
): boolean {
  return (
    proposal.entry_date_reason === null &&
    proposal.lines.some((line) => VAT_SETTLEMENT_NET_ACCOUNTS.includes(line.account_number))
  )
}
