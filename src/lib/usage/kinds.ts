/**
 * The priced services: each one a month includes some of, and charges a
 * unit price for above that, billed in arrears (accounted.se/priser).
 *
 * This file is the one place a price lives. The usage view, the monthly
 * statements and the invoice lines all read it, so a price change is one
 * line here.
 *
 * Prices are whole öre exkl. moms. A kind whose price is not decided has
 * `unitPriceOre: null`: it is counted and shown, never billed. A kind that is
 * always included has `unitPriceOre: 0`.
 *
 * Nothing is billed until a kind is switched on in USAGE_BILLING_KINDS
 * (billedUsageKinds below): until then the monthly statements are previews.
 * This file imports nothing, so any module may read it.
 */

export const USAGE_KINDS = ['bank_payment', 'peppol_send', 'kivra_send', 'billo_send', 'signing'] as const

export type UsageKind = (typeof USAGE_KINDS)[number]

export interface UsagePrice {
  /** What a month includes; null when the kind has no included amount (not priced yet, or always included). */
  includedPerMonth: number | null
  /** Öre exkl. moms per unit above the included amount; null when not priced yet, 0 when always included. */
  unitPriceOre: number | null
}

/**
 * Bank payments and Peppol sends carry the prices published on
 * accounted.se/priser (2026-10-30); Kivra sends and signed documents the
 * prices set 2026-11-02. Billo is included. An annual report's signing is
 * not counted (counters.ts), so it is always included.
 *
 * The bank payments figure is BANK_PAYMENTS_INCLUDED_PER_MONTH: written out
 * here because lib/payments/usage.ts reads this file, and a test pins the two
 * equal.
 */
export const USAGE_PRICES: Readonly<Record<UsageKind, UsagePrice>> = Object.freeze({
  bank_payment: { includedPerMonth: 10, unitPriceOre: 200 },
  peppol_send: { includedPerMonth: 10, unitPriceOre: 100 },
  kivra_send: { includedPerMonth: 0, unitPriceOre: 300 },
  billo_send: { includedPerMonth: null, unitPriceOre: 0 },
  signing: { includedPerMonth: 3, unitPriceOre: 1000 },
})

/** What a kind is called on the invoice line (Swedish: the invoice is). */
export const USAGE_INVOICE_LABELS: Readonly<Record<UsageKind, string>> = Object.freeze({
  bank_payment: 'Betalningar via banken',
  peppol_send: 'Skickade e-fakturor via Peppol',
  kivra_send: 'Utskick till Kivra',
  billo_send: 'Utskick till Billo',
  signing: 'Signerade dokument med BankID',
})

/** The units in a Swedish sentence ("Månadens 10 bankbetalningar som ingår är använda"). */
export const USAGE_UNITS_SV: Readonly<Record<UsageKind, string>> = Object.freeze({
  bank_payment: 'bankbetalningar',
  peppol_send: 'e-fakturor via Peppol',
  kivra_send: 'utskick till Kivra',
  billo_send: 'utskick till Billo',
  signing: 'signeringar',
})

/**
 * The kinds whose paid action stops at the included amount until an admin
 * accepts the charge (lib/usage/gate.ts; bank payments in
 * lib/payments/allowance.ts). A kind gets a price only once its action is
 * here: a test fails on a priced kind that is not, so nothing is ever
 * charged that nobody was asked about.
 */
export const USAGE_GATED_KINDS: ReadonlySet<UsageKind> = new Set<UsageKind>(['bank_payment', 'peppol_send', 'kivra_send', 'signing'])

export function isUsageKind(value: unknown): value is UsageKind {
  return typeof value === 'string' && (USAGE_KINDS as readonly string[]).includes(value)
}

/** Whether the kind has a price above zero, so it can be billed at all. */
export function isPricedKind(kind: UsageKind): boolean {
  const price = USAGE_PRICES[kind].unitPriceOre
  return price !== null && price > 0
}

/**
 * The kinds the monthly statements bill: USAGE_BILLING_KINDS, comma-separated
 * kinds, or `*` for every priced kind. Unset or empty bills nothing, so a
 * deploy alone never starts charging anyone. A listed kind without a price
 * is ignored.
 */
export function billedUsageKinds(env: Record<string, string | undefined> = process.env): Set<UsageKind> {
  const raw = env.USAGE_BILLING_KINDS?.trim()
  if (!raw) return new Set()
  const wanted = raw === '*' ? [...USAGE_KINDS] : raw.split(',').map((s) => s.trim())
  return new Set(wanted.filter(isUsageKind).filter(isPricedKind))
}

/** One kind's month for one company: what was used, what is included, and what that costs. */
export interface UsageLine {
  kind: UsageKind
  used: number
  /** Null when the kind has no included amount. */
  included: number | null
  /** Units above the included amount that carry a price; 0 for an unpriced or included kind. */
  billable: number
  /** Null when not priced yet. */
  unit_price_ore: number | null
  /** billable x unit_price_ore, whole öre. */
  amount_ore: number
}

/**
 * The line for `used` units of a kind. `includedOverride` replaces the
 * registry's included amount for one company (a bank payments allowance a
 * founder set, plus bought packs). Integer arithmetic only: öre never pass
 * through a float.
 */
export function usageLine(kind: UsageKind, used: number, includedOverride?: number | null): UsageLine {
  const price = USAGE_PRICES[kind]
  const included = includedOverride ?? price.includedPerMonth
  const unit = price.unitPriceOre
  const billable = unit ? Math.max(0, used - (included ?? 0)) : 0
  return { kind, used, included, billable, unit_price_ore: unit, amount_ore: billable * (unit ?? 0) }
}

/** "2,00 kr" for 200 öre: the invoice line's unit price, without a float. */
export function formatOre(ore: number): string {
  const kronor = Math.trunc(ore / 100)
  const rest = Math.abs(ore % 100)
  return `${kronor.toLocaleString('sv-SE')},${String(rest).padStart(2, '0')} kr`
}
