import type { SupabaseClient } from '@supabase/supabase-js'
import { businessAccount, reverseChargeBoxesOf, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import {
  costAccountRcBasisRate,
  generateReverseChargePurchaseLines,
  isReverseChargeVatAccount,
  reverseChargeKindForBasisAccount,
  reverseChargeKindOnOwnAccount,
  type ChartVatTreatments,
  type ReverseChargeKind,
} from '@/lib/bookkeeping/vat-entries'
import { createLogger } from '@/lib/logger'
import type { Transaction } from '@/types'
import { loadBookingPrecedents, type PrecedentBooking } from './booking-precedent'

/**
 * Whether a learned counterpart's reverse-charge box is known before it books
 * from the row's one click (reverse_charge_box_unconfirmed on the proposal,
 * read by ./direct-booking.ts).
 *
 * A counterpart learned as one pair stores no box: it replays the EU-service
 * default at 25 % (ruta 21, basis 4535; learnedReverseChargeLines in
 * counterparty-templates.ts). The box turns on where the seller is: ruta 21
 * for a service from a seller in another EU country, ruta 22 for one from a
 * seller outside the EU (Skatteverket, "Fylla i momsdeklarationen", fält 21
 * and 22). A pair learned before learning refused a purchase outside the EU
 * (crm#1028), or learned from the same name's EU purchases, books ruta 21
 * for a seller the company has always reported in ruta 22.
 *
 * The box is confirmed, and the pair books as before, when:
 *   - its cost account reports the box itself (a BAS basis account such as
 *     4531, or a momskod that reports ruta 20-24): the booking takes that
 *     account's box (reconcileRcBasisWithChart), so the default never applies;
 *   - or every reverse-charge purchase among the company's posted bookings of
 *     the counterparty in the precedent window (./booking-precedent.ts)
 *     reported its basis in the box, and at the sats, the pair books, and
 *     there is at least one.
 * Anything else, a failed read included, is unconfirmed: the row opens the
 * review, which shows the box to pick (QuickReviewDialog). The agent's
 * arguments keep plain 'reverse_charge', so the categorize door reads the box
 * off the row's underlag or asks for it (lib/vat/reverse-charge-box.ts).
 *
 * The posted bookings are read as they stand: one the pair itself booked
 * from one click counts like one a person booked, since the lines do not say
 * who chose the box.
 */

const log = createLogger('transactions/reverse-charge-box-evidence')

/** A reverse-charge basis as the momsdeklaration buckets it: the box and the sats. */
type Basis = `${ReverseChargeKind}@${number}`

const basisKey = (kind: ReverseChargeKind, rate: number): Basis => `${kind}@${rate}`

/** The basis a pair books for `kind`: the basis account generateReverseChargePurchaseLines picks. */
function pairBasis(kind: ReverseChargeKind): Basis | null {
  for (const line of generateReverseChargePurchaseLines({ base: 100, kind })) {
    const basis = reverseChargeKindForBasisAccount(line.account_number)
    if (basis) return basisKey(basis.kind, basis.rate)
  }
  return null
}

/**
 * The basis a proposal books by default, and its cost account, when it is a
 * learned pair that books reverse charge on a cost account that is no basis
 * account; null for anything else. The chart is not read here: an account
 * whose momskod reports a box is told apart once the chart is loaded.
 */
function defaultBasisOfPair(p: BookingProposal, tx: Pick<Transaction, 'amount'>): { basis: Basis; cost: string } | null {
  if (p.source !== 'counterparty' || p.booking.kind !== 'counterparty') return null
  if (p.line_pattern && p.line_pattern.length > 0) return null
  // A refund against the learned purchase already asks (direction_mismatch).
  if (p.direction_mismatch || tx.amount >= 0) return null
  if (p.vat_treatment !== 'reverse_charge') return null
  const cost = businessAccount(p)
  if (reverseChargeKindForBasisAccount(cost)) return null
  const boxes = reverseChargeBoxesOf(p)
  const basis = boxes.length === 1 ? pairBasis(boxes[0]) : null
  return basis ? { basis, cost } : null
}

/**
 * The bases one posted purchase reported: a basis account on the debit side
 * (4535, 4531, 4536 ...), or a cost account whose momskod reports ruta 20-24
 * itself, each with its sats.
 */
function basesOfBooking(booking: PrecedentBooking, chart: ChartVatTreatments): Set<Basis> {
  const bases = new Set<Basis>()
  for (const l of booking.lines) {
    if (!(Number(l.debit) > 0)) continue
    const code = chart.get(l.account)
    const own = reverseChargeKindOnOwnAccount(l.account, code)
    const rate = costAccountRcBasisRate(l.account, code)
    if (own && rate !== null) bases.add(basisKey(own.kind, rate))
  }
  return bases
}

/**
 * Whether the company's posted bookings of a counterparty confirm a box at
 * the pair's sats: every purchase among them that carries reverse-charge
 * moms reported its basis there and nowhere else, and there is at least one.
 * Money in (a refund) is not read.
 */
export function historyConfirmsBox(
  bookings: readonly PrecedentBooking[],
  kind: ReverseChargeKind,
  chart: ChartVatTreatments,
): boolean {
  const basis = pairBasis(kind)
  return basis !== null && historyConfirmsBasis(bookings, basis, chart)
}

function historyConfirmsBasis(bookings: readonly PrecedentBooking[], basis: Basis, chart: ChartVatTreatments): boolean {
  const purchases = bookings.filter(
    (b) => Number(b.amount) < 0 && b.lines.some((l) => isReverseChargeVatAccount(l.account)),
  )
  if (purchases.length === 0) return false
  return purchases.every((b) => {
    const bases = basesOfBooking(b, chart)
    return bases.size === 1 && bases.has(basis)
  })
}

/**
 * Marks reverse_charge_box_unconfirmed on every learned pair whose box the
 * cost account and the company's posted bookings do not confirm (see the
 * file header). The chart and the bookings are read once, side by side, and
 * only when such a pair is on offer.
 */
export async function markUnconfirmedReverseChargeBoxes(
  supabase: SupabaseClient,
  companyId: string,
  transactions: readonly Transaction[],
  proposals: Record<string, BookingProposal[]>,
): Promise<void> {
  const pending = transactions.flatMap((tx) =>
    (proposals[tx.id] ?? []).flatMap((p) => {
      const pair = defaultBasisOfPair(p, tx)
      return pair ? [{ tx, p, ...pair }] : []
    }),
  )
  if (pending.length === 0) return

  const rows = [...new Map(pending.map(({ tx }) => [tx.id, tx])).values()]
  const [chart, precedents] = await Promise.all([
    fetchChartVatTreatments(supabase, companyId).catch((err: unknown): ChartVatTreatments => {
      log.warn('chart read failed; a learned reverse-charge pair asks for its box', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      return new Map()
    }),
    loadBookingPrecedents(supabase, companyId, rows).catch((err: unknown) => {
      log.warn('booking precedents read failed; a learned reverse-charge pair asks for its box', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      return new Map<string, PrecedentBooking[]>()
    }),
  ])

  for (const { tx, p, basis, cost } of pending) {
    if (reverseChargeKindOnOwnAccount(cost, chart.get(cost))) continue
    if (historyConfirmsBasis(precedents.get(tx.id) ?? [], basis, chart)) continue
    proposals[tx.id] = (proposals[tx.id] ?? []).map((x) => (x === p ? { ...x, reverse_charge_box_unconfirmed: true } : x))
  }
}
