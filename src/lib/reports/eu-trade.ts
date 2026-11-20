/**
 * Trade with other EU countries as the momsdeklaration shows it. A reading of
 * the declaration's rutor, so it sits with the declaration in the ledger
 * kernel, where the deadline calendar may read it too (lib/vat/eu-trade.ts
 * re-exports it).
 *
 * Helårsmoms is due earlier for a company that traded with other EU countries
 * during the beskattningsår: an enskild firma 26 February instead of 12 May,
 * an aktiebolag or förening the 26th of the second month after the year end
 * instead of the inkomstdeklaration date (swedish-accounting-compliance,
 * references/skatteverket.md, reporting periods; swedish-vat reference
 * section 1). The company setting vat_has_eu_trade is a statement about the
 * books, so the books can answer it: these are the SKV 4700 boxes that hold
 * intra-EU trade (swedish-vat reference sections 2.2, 2.3 and 7):
 *
 *   purchases: 20 varor från annat EU-land, 21 tjänster från annat EU-land
 *              (huvudregeln), 37 mellanmans inköp vid trepartshandel;
 *   sales:     35 varor till annat EU-land, 38 mellanmans försäljning vid
 *              trepartshandel, 39 tjänster till annat EU-land (huvudregeln).
 *
 * Rutor 22 (tjänster utanför EU), 36 (export) and 50 (import) are trade
 * outside the EU and rutor 23-24 and 41 domestic reverse charge: none counts.
 * Purchases count as well as sales, as the settings page has always said
 * ("Köp eller försäljning inom EU påverkar datumet för årsmoms"); a wrong
 * "yes" only moves the date earlier, a wrong "no" makes the filing late.
 */
import { formatAmount } from '@/lib/utils'
import type { VatDeclarationRutor } from '@/types'

export const EU_TRADE_PURCHASE_RUTOR = ['ruta20', 'ruta21', 'ruta37'] as const
export const EU_TRADE_SALES_RUTOR = ['ruta35', 'ruta38', 'ruta39'] as const

export type EuTradeRuta =
  | (typeof EU_TRADE_PURCHASE_RUTOR)[number]
  | (typeof EU_TRADE_SALES_RUTOR)[number]

export interface EuTradeBox {
  /** Two-digit ruta number, e.g. '21'. */
  ruta: string
  /** The ruta's öre value as the declaration projects it. */
  amount: number
}

export interface EuTradeInRutor {
  purchases: EuTradeBox[]
  sales: EuTradeBox[]
}

function boxes(rutor: Pick<VatDeclarationRutor, EuTradeRuta>, keys: readonly EuTradeRuta[]): EuTradeBox[] {
  return keys
    .filter((key) => (rutor[key] ?? 0) !== 0)
    .map((key) => ({ ruta: key.slice(4), amount: rutor[key] }))
}

/** The EU-trade boxes with an amount in these rutor, purchases and sales apart. */
export function euTradeInRutor(rutor: Pick<VatDeclarationRutor, EuTradeRuta>): EuTradeInRutor {
  return {
    purchases: boxes(rutor, EU_TRADE_PURCHASE_RUTOR),
    sales: boxes(rutor, EU_TRADE_SALES_RUTOR),
  }
}

/** True when any EU-trade box carries an amount. */
export function hasEuTrade(rutor: Pick<VatDeclarationRutor, EuTradeRuta>): boolean {
  const found = euTradeInRutor(rutor)
  return found.purchases.length > 0 || found.sales.length > 0
}

/**
 * Whether a helårsmoms period has the earlier EU-trade due date: the company
 * says it trades with other EU countries (vat_has_eu_trade), or the
 * räkenskapsår's own rutor show it (hasEuTrade). The setting is a statement
 * about the books, so the books can answer it: the deadline list, the
 * payment day and the VAT close check all read this one rule (crm#1171).
 * A wrong yes only moves the date earlier; a wrong no makes the filing late.
 */
export function helarsmomsHasEuTrade(setting: boolean | null | undefined, booksShowEuTrade: boolean): boolean {
  return setting === true || booksShowEuTrade
}

/** "ruta 21: 448,41 kr, ruta 39: 1 200,00 kr", for a finding message. */
export function formatEuTradeBoxes(found: EuTradeInRutor): string {
  return [...found.purchases, ...found.sales]
    .sort((a, b) => a.ruta.localeCompare(b.ruta))
    .map((box) => `ruta ${box.ruta}: ${formatAmount(box.amount)} kr`)
    .join(', ')
}
