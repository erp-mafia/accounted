import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import type { WebshopPayout, WebshopPayoutLine, WebshopPayoutLineKind } from '@/types'

/**
 * A payment provider's payout as one verifikat against its bank row: the
 * payout model Kustom's settlement report and Shopify Payments share.
 *
 * The orders already booked each sale and return against the store's clearing
 * account (1686 unless the store maps the payment method elsewhere), with
 * their revenue and output VAT: the sales are never booked from the payout.
 * The payout settles that receivable. Its verifikat therefore has three
 * parts, the same three the provider's report has (the line kinds mirror the
 * collections settlement's: what the payout is made of, signed toward it):
 *
 *   Dr bank            the net payout (the bank row's own amount)
 *   Dr 6570            the provider's fees, excluding VAT
 *   Dr 2641            the VAT the provider charges on its fees
 *   Cr clearing        net + fees + fee VAT: what the payout settles
 *
 * A provider fee is a cost, never netted against revenue (ÅRL 2 kap. 4 §).
 * Kustom treats its fees as a taxable service and charges VAT on them, as
 * HFD 2019 ref. 45 held for the checkout service it took over from Klarna:
 * for a VAT-registered company that VAT is ingående moms on 2641 (ML 13 kap.),
 * deducted against Kustom's invoice for its fees. A company that is not
 * VAT-registered has no deduction, so the VAT is part of the cost. An
 * acquiring fee without VAT (Shopify Payments) books on 6570 alone.
 *
 * Holdbacks, releases and reversals move the receivable, not the fee: the
 * clearing credit is what the payout settled, and whatever the clearing
 * account still holds after it (a holdback, a reversed sale the orders booked)
 * is the provider's to pay or a person's to book. A payout with any other
 * part (an adjustment: a commission, a fee correction, a repayment) is not
 * proposed: what it is cannot be read from the report, so a person books it.
 * Nor is one whose fee VAT is not 25 % of its fees, the rate Kustom charges:
 * a column read wrong must not reach ruta 48.
 */

/** The fee account (BAS 6570 Bankkostnader): payment provider and acquiring fees. */
export const PAYOUT_FEE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'payment_fees')
/** Debiterad ingående moms (BAS 2641): the VAT on the provider's fees. */
export const PAYOUT_FEE_VAT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'input_vat')

/** Kinds that reduce the payout: their signed amount is negative. */
const OUTGOING_KINDS: ReadonlySet<WebshopPayoutLineKind> = new Set(['return', 'reversal', 'fee', 'fee_vat', 'holdback'])

/** Kinds that add to the payout: their signed amount is positive. */
const INCOMING_KINDS: ReadonlySet<WebshopPayoutLineKind> = new Set(['sale', 'release'])

/** One part of a payout, signed toward it; zero parts are left out. */
export function payoutLine(kind: WebshopPayoutLineKind, magnitudeOrSigned: number): WebshopPayoutLine | null {
  const amount = roundOre(
    OUTGOING_KINDS.has(kind)
      ? -Math.abs(magnitudeOrSigned)
      : INCOMING_KINDS.has(kind)
        ? Math.abs(magnitudeOrSigned)
        : magnitudeOrSigned,
  )
  return amount === 0 ? null : { kind, amount }
}

/** The payout's parts as stored: non-zero, signed toward the payout. */
export function payoutLines(parts: ReadonlyArray<[WebshopPayoutLineKind, number]>): WebshopPayoutLine[] {
  return parts.map(([kind, amount]) => payoutLine(kind, amount)).filter((l): l is WebshopPayoutLine => l !== null)
}

/** The Swedish standard rate (ML 2023:200 9 kap. 2 §), the one a provider's fee VAT is charged at. */
const FEE_VAT_RATE = 0.25

/**
 * Whether the fee VAT is the standard rate of the fees. The provider rounds
 * the VAT of each fee line before summing, so the sum may stray from 25 % of
 * the summed fees by up to half an öre per line: one krona, or 0,5 % of the
 * VAT on a payout with more lines than that, is allowed.
 */
export function feeVatFitsRate(fees: number, feeVat: number): boolean {
  const expected = netVat(fees, FEE_VAT_RATE)
  const tolerance = Math.max(1, expected * 0.005)
  return Math.abs(roundOre(feeVat - expected)) <= tolerance
}

/** The magnitude of one kind's parts. */
function totalOf(lines: readonly WebshopPayoutLine[], kind: WebshopPayoutLineKind): number {
  return Math.abs(sumOre(lines.filter((l) => l.kind === kind).map((l) => l.amount)))
}

export type PayoutPlanRefusal =
  /** Only payouts in the ledger currency are proposed: the clearing account and the bank row are booked in it. */
  | 'currency'
  /** The parts do not add up to the payout: a report read wrong, never guessed past. */
  | 'parts_do_not_add_up'
  /** The payout settles nothing of the receivable (fees above what it carries). */
  | 'nothing_to_clear'
  /** A part the report does not name (commission, fee correction, repayment): a person books it. */
  | 'adjustment'
  /** The fee VAT is not 25 % of the fees, beyond the rounding of one fee line at a time. */
  | 'fee_vat_rate'

export interface PayoutVoucherLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

export interface PayoutVoucherPlan {
  /** Credit on the clearing account: net + fees + fee VAT. */
  clearing: number
  /** The provider's fees, excluding VAT. */
  fees: number
  /** The VAT the provider charges on its fees. */
  feeVat: number
  /** Every line beside the bank leg, which books the payout's net. */
  lines: PayoutVoucherLine[]
}

export interface PayoutPlanInput {
  payout: Pick<WebshopPayout, 'platform' | 'reference' | 'payout_date' | 'currency' | 'amount' | 'lines'>
  /** The store's clearing account for the payout's payment method. */
  clearingAccount: string
  /** company_settings.vat_registered (a missing value counts as registered). */
  vatRegistered: boolean
}

const PROVIDER_LABELS: Record<WebshopPayout['platform'], string> = {
  kustom: 'Kustom',
  shopify: 'Shopify Payments',
}

/** The provider as the verifikat and the proposal name it. */
export function payoutProviderLabel(platform: WebshopPayout['platform']): string {
  return PROVIDER_LABELS[platform]
}

/** The verifikat text: provider, reference and day. */
export function payoutDescription(payout: Pick<WebshopPayout, 'platform' | 'reference' | 'payout_date'>): string {
  const reference = payout.reference ? ` ${payout.reference}` : ''
  return `Utbetalning ${payoutProviderLabel(payout.platform)}${reference} ${payout.payout_date}`
}

/**
 * The payout's verifikat beside its bank leg, or why it cannot be proposed.
 * Pure: the caller resolves the clearing account and the VAT registration.
 */
export function planPayoutVoucher(
  input: PayoutPlanInput,
): { ok: true; plan: PayoutVoucherPlan } | { ok: false; reason: PayoutPlanRefusal } {
  const { payout } = input
  if (!isLedgerCurrency(payout.currency.toUpperCase())) return { ok: false, reason: 'currency' }
  const lines = payout.lines ?? []
  if (!equalOre(sumOre(lines.map((l) => l.amount)), payout.amount)) {
    return { ok: false, reason: 'parts_do_not_add_up' }
  }
  if (lines.some((l) => l.kind === 'adjustment' && l.amount !== 0)) return { ok: false, reason: 'adjustment' }
  const fees = totalOf(lines, 'fee')
  const feeVat = totalOf(lines, 'fee_vat')
  if (feeVat > 0 && !feeVatFitsRate(fees, feeVat)) return { ok: false, reason: 'fee_vat_rate' }
  const clearing = sumOre([payout.amount, fees, feeVat])
  if (!(clearing > 0) || !(payout.amount > 0)) return { ok: false, reason: 'nothing_to_clear' }

  const provider = payoutProviderLabel(payout.platform)
  const voucher: PayoutVoucherLine[] = []
  if (input.vatRegistered) {
    if (fees > 0) {
      voucher.push({ account_number: PAYOUT_FEE_ACCOUNT, debit_amount: fees, credit_amount: 0, description: `Avgifter ${provider}` })
    }
    if (feeVat > 0) {
      voucher.push({ account_number: PAYOUT_FEE_VAT_ACCOUNT, debit_amount: feeVat, credit_amount: 0, description: `Moms på avgifter ${provider}` })
    }
  } else {
    const cost = sumOre([fees, feeVat])
    if (cost > 0) {
      voucher.push({ account_number: PAYOUT_FEE_ACCOUNT, debit_amount: cost, credit_amount: 0, description: `Avgifter ${provider} inklusive moms` })
    }
  }
  voucher.push({
    account_number: input.clearingAccount,
    debit_amount: 0,
    credit_amount: clearing,
    description: payoutDescription(payout),
  })
  return { ok: true, plan: { clearing, fees, feeVat, lines: voucher } }
}
