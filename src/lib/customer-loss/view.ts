/**
 * What the invoice page and the kundförlust dialog show (build spec 3.10):
 * whether the menu entry shows, what each kind would book right now, the
 * reserve held, and the decisions already made. Read-only.
 */
import { roundOre } from '@/lib/money'
import { liveRows, type VatShare } from './amounts'
import { planConfirmed } from './confirmed'
import { planDoubtful } from './doubtful'
import { customerLossMenuVisible, openClaimRefusal } from './eligibility'
import type { CustomerLossErrorCode } from './errors'
import type { CustomerLossState } from './state'

export interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
}

export interface CustomerLossView {
  /** CUSTOMER_LOSS_ENABLED: the menu and every new decision. */
  enabled: boolean
  menuVisible: boolean
  invoiceStatus: string
  accountingMethod: 'accrual' | 'cash'
  /** The invoice reached the ledger as a fordran. */
  booked: boolean
  remaining: number
  /** The befarad reserve still on 1519. */
  reserve: number
  caseOpen: boolean
  doubtful:
    | { available: true; reserve: number; vat: number; lines: PreviewLine[] }
    | { available: false; refusal: CustomerLossErrorCode }
  confirmed:
    | {
        available: true
        amount: number
        net: number
        vat: number
        shares: VatShare[]
        reserveReleased: number
        /** null: never booked (kontantmetoden), no voucher. */
        lines: PreviewLine[] | null
      }
    | { available: false; refusal: CustomerLossErrorCode }
  /**
   * On a written-off invoice: how much a recovery can still take. caseOpen:
   * the collection case is still open, so a payment straight to the company
   * is not booked here until the case is closed or withdrawn.
   */
  recovery: { available: boolean; left: number; booked: boolean; caseOpen: boolean } | null
  decisions: Array<{
    id: string
    kind: string
    entry_date: string
    amount: number
    net_amount: number
    vat_amount: number
    journal_entry_id: string | null
    evidence_document_id: string | null
    reason: string
    annulled: boolean
  }>
}

const toPreview = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>): PreviewLine[] =>
  lines.map((l) => ({ account_number: l.account_number, debit_amount: l.debit_amount, credit_amount: l.credit_amount }))

export function buildCustomerLossView(state: CustomerLossState, opts: { enabled: boolean; today: string }): CustomerLossView {
  const doubtful = planDoubtful(state)
  const claimRefusal = openClaimRefusal(state)
  const confirmed = claimRefusal ? null : planConfirmed(state)
  const live = new Set(liveRows(state.rows).map((r) => r.id))
  const recovered = liveRows(state.rows)
    .filter((r) => r.kind === 'recovered')
    .reduce((sum, r) => sum + Number(r.amount), 0)

  return {
    enabled: opts.enabled,
    menuVisible: opts.enabled && customerLossMenuVisible(state.invoice, state.latestCase, opts.today),
    invoiceStatus: state.invoice.status,
    accountingMethod: state.accountingMethod,
    booked: state.booked,
    remaining: state.invoice.remaining_amount,
    reserve: state.reserve,
    caseOpen: state.latestCase?.is_open === true,
    doubtful: doubtful.ok
      ? { available: true, reserve: doubtful.plan.reserve, vat: doubtful.plan.vat, lines: toPreview(doubtful.plan.lines) }
      : { available: false, refusal: doubtful.code },
    confirmed: confirmed
      ? {
          available: true,
          amount: confirmed.amount,
          net: confirmed.net,
          vat: confirmed.vat,
          shares: confirmed.shares,
          reserveReleased: confirmed.reserveReleased,
          lines: confirmed.lines ? toPreview(confirmed.lines) : null,
        }
      : { available: false, refusal: claimRefusal as CustomerLossErrorCode },
    recovery:
      state.invoice.status === 'written_off' && state.confirmed
        ? {
            booked: !!state.confirmed.journal_entry_id,
            left: Math.max(0, roundOre(Number(state.confirmed.amount) - recovered)),
            caseOpen: state.latestCase?.is_open === true,
            available: opts.enabled && !!state.confirmed.journal_entry_id && state.latestCase?.is_open !== true,
          }
        : null,
    decisions: state.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      entry_date: r.entry_date,
      amount: Number(r.amount),
      net_amount: Number(r.net_amount),
      vat_amount: Number(r.vat_amount),
      journal_entry_id: r.journal_entry_id,
      evidence_document_id: r.evidence_document_id,
      reason: r.reason,
      annulled: r.kind !== 'annulled' && !live.has(r.id),
    })),
  }
}
