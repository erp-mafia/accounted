/**
 * A Kustom settlement report (the CSV the Kustom portal exports per payout)
 * read into Orders-page rows: every SALE becomes an order, every RETURN a
 * refund, through the same upsertWebshopOrders write the Zettle, Shopify and
 * WooCommerce feeds use. Nothing here books anything; the user books the rows
 * from the Orders page, one verifikat per day like any other store.
 *
 * Kustom has no API connection here, so the file is the feed. One report is
 * one payout: a summary record (total_sale_amount ... total_settlement_amount,
 * payout_date, merchant_id), then one record per transaction (type, amount,
 * capture_date, order_id, capture_id or refund_id, ...).
 *
 * Dates. A SALE is a capture: the merchant captures when the goods ship, so
 * the capture is the delivery and the beskattningsgrundande händelse (ML
 * 2023:200 7 kap. 4 §), and its output VAT belongs to the period the delivery
 * is booked in (7 kap. 14 §). The row's paid_date, which the day booking
 * dates its verifikat by, is therefore the capture's Swedish calendar day, not
 * the payout day: a sale captured on 30 November and paid out on 2 December
 * is a November sale. Kustom writes its dates in UTC, so a capture date must
 * carry its time: a bare date is the UTC day, which near midnight is the
 * wrong Swedish day and, on 31 December, the wrong year.
 *
 * VAT. The default report has no VAT on the merchant's own sales; Kustom adds
 * it per rate (tax_rate_N in basis points, tax_amount_N) when consumer VAT is
 * switched on. A file without those columns is refused: every row would need
 * a guessed rate.
 *
 * Held, never guessed (the Zettle feed's doctrine for purchases its row model
 * cannot express). A sale is imported unbookable (is_paid false, its reason in
 * payment_method_title) when its VAT does not add up to its amount, when it
 * went to a customer outside Sweden (the Orders page's country rules route
 * Shopify rows only, so a Danish order at 25 % would book as Swedish VAT),
 * when it was paid in a shop (Kustom's in-person lines; the till's daily
 * report covers those), or when the shop's own feed already has the order. A
 * refund row is bookable whatever its status, so such a return is imported
 * without a VAT split (bulk and day booking refuse it, the single dialog shows
 * its lines to a person) or, when the sale belongs to the till or the shop's
 * feed, left out.
 *
 * Left out on purpose: the payout itself and Kustom's fees. The payout lands
 * as a bank row and is booked from there against 1686, as for Zettle; the
 * summary this returns gives the user the numbers for it. Whether the VAT
 * Kustom charges on its fees is deductible is not decided here.
 */
import { equalOre, inferDecimalMark, parseSwedishAmount, roundOre, sumOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isSaneDateString } from '@/lib/invariants'
import { splitCsvRecords } from '@/lib/import/source-chart/parse-chart-csv'
import type { WebshopVatBreakdownLine } from '@/types'
import type { WebshopOrderUpsert } from './types'

/** Consumer VAT per rate comes in up to this many column pairs. */
const CONSUMER_VAT_PAIRS = 4

/**
 * How far net + VAT may miss a row's amount and still be rounding: two öre
 * of VAT rounding per rate, carried over to the net (0.08 kr at 25 %, 0.33 kr
 * at 6 %). Anything above is a part of the amount the report gives no VAT
 * for (a gift card, a 0 % line), and the row is held.
 */
const VAT_ROUNDING_PER_RATE = 0.02

const COUNTRY_SWEDEN = 'SE'

/** Why a row cannot be booked from the Orders page without a person. */
export type KustomHoldReason = 'vat' | 'abroad' | 'in_store' | 'elsewhere'

/** Stored as the row's payment_method_title, which the Orders page shows. */
const HOLD_TITLES: Record<KustomHoldReason, string> = {
  vat: 'Kustom: momsen i rapporten går inte ihop med beloppet, bokför manuellt',
  abroad: 'Kustom: levererad utanför Sverige, bokför manuellt',
  in_store: 'Kustom: köp i butik, bokför manuellt',
  elsewhere: 'Kustom: ordern finns redan från butiken, bokför inte två gånger',
}

/** A return held for these reasons is not imported: its sale is booked elsewhere. */
const LEFT_OUT_REASONS: ReadonlySet<KustomHoldReason> = new Set(['in_store', 'elsewhere'])

export type KustomSettlementRefusal =
  /** Not a Kustom settlement report: no summary or no transaction header. */
  | 'KUSTOM_SETTLEMENT_NOT_RECOGNIZED'
  /** Consumer VAT (tax_rate_1 / tax_amount_1 ...) is not in the file. */
  | 'KUSTOM_SETTLEMENT_NO_CONSUMER_VAT'
  /** capture_id or refund_id is missing, so a row has no stable key. */
  | 'KUSTOM_SETTLEMENT_ID_COLUMNS_MISSING'
  /** The same capture or refund twice in one file. */
  | 'KUSTOM_SETTLEMENT_DUPLICATE_ROW'
  /** Amounts are not decimals (the portal's minor-units format), or a cell is not an amount. */
  | 'KUSTOM_SETTLEMENT_AMOUNT_FORMAT'
  /** A capture date without its time, or a date cell that is not ISO. */
  | 'KUSTOM_SETTLEMENT_DATE_FORMAT'
  /** The transactions do not add up to the summary: a cut or edited file. */
  | 'KUSTOM_SETTLEMENT_TOTALS_MISMATCH'

/** The payout as the summary states it, for booking the bank row by hand. */
export interface KustomPayout {
  reference: string | null
  merchantId: string
  /** YYYY-MM-DD, or null when the report leaves it out. */
  payoutDate: string | null
  currency: string
  sales: number
  returns: number
  /** Reversed (disputed) purchases: not on the Orders page, booked by hand. */
  reversals: number
  /** Kustom's fees excluding VAT (total_fee_amount). */
  fees: number
  /** The VAT Kustom charges on its fees (total_tax_amount). */
  feeVat: number
  /** Held back from this payout: still owed by Kustom, not a cost. */
  holdback: number
  /** Released from earlier holdbacks. */
  release: number
  /** Everything else the payout nets in: corrections, charges, credits, debt. */
  other: number
  /** What Kustom pays out (total_settlement_amount). */
  settlement: number
}

export interface KustomSettlementReport {
  payout: KustomPayout
  rows: WebshopOrderUpsert[]
  /** SALE rows imported unbookable, each with its reason. */
  salesHeld: number
  /** RETURN rows imported without a VAT split: booked one at a time. */
  returnsHeld: number
  /** RETURN rows not imported because their sale is booked elsewhere. */
  returnsLeftOut: { count: number; total: number }
}

/** One SALE or RETURN as read from the file, before it is held or not. */
export interface KustomEntry {
  kind: 'sale' | 'return'
  amount: number
  /** null when the report gives no VAT for the row or it does not add up. */
  vat: WebshopVatBreakdownLine[] | null
  /** Held on what the file itself shows (in a shop, abroad); VAT is judged later. */
  hold: KustomHoldReason | null
  row: WebshopOrderUpsert
}

/** A report as read, before it is compared with what the Orders page already has. */
export interface KustomSettlementFile {
  payout: KustomPayout
  entries: KustomEntry[]
}

export type KustomSettlementOutcome =
  | { ok: true; file: KustomSettlementFile }
  | { ok: false; code: KustomSettlementRefusal }

/**
 * ⚠️ STORED-KEY FORMAT. Persisted to webshop_orders.external_id: changing it
 * orphans every row imported before and lets the same file import twice.
 */
export function kustomCaptureExternalId(merchantId: string, captureId: string): string {
  return `kustom_${merchantId}_capture_${captureId}`
}

/** ⚠️ STORED-KEY FORMAT, as kustomCaptureExternalId. */
export function kustomRefundExternalId(merchantId: string, refundId: string): string {
  return `kustom_${merchantId}_refund_${refundId}`
}

/** The delimiter of the first record: Kustom writes ; by default, , or tab when set so. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const counts: Array<[string, number]> = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1])
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ';'
}

type CsvRecord = Map<string, string>

function toRecord(header: string[], fields: string[]): CsvRecord {
  const record = new Map<string, string>()
  header.forEach((name, i) => record.set(name, (fields[i] ?? '').trim()))
  return record
}

function cell(record: CsvRecord, name: string): string {
  return record.get(name) ?? ''
}

/**
 * The Swedish calendar day of a Kustom timestamp. Kustom writes UTC, so a
 * timestamp without an offset is read as UTC, never in the server's zone.
 * Null for anything but an ISO timestamp, a bare date included.
 */
function swedishDayOf(value: string): string | null {
  if (value[10] !== 'T' || !isSaneDateString(value.slice(0, 10))) return null
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`
  const ms = Date.parse(zoned)
  return Number.isFinite(ms) ? todayIsoStockholm(new Date(ms)) : null
}

/**
 * The row's VAT per rate, or null when the report gives none or it does not
 * add up to the amount. Net per rate is the tax over the rate; the öre that
 * rounding leaves goes to the largest bucket, so net + tax is the amount.
 */
function vatBreakdownOf(
  amount: number,
  pairs: Array<{ rate: number; tax: number }>,
): WebshopVatBreakdownLine[] | null {
  const taxByRate = new Map<number, number>()
  for (const { rate, tax } of pairs) {
    if (tax === 0) continue
    if (!(rate > 0)) return null
    taxByRate.set(rate, roundOre((taxByRate.get(rate) ?? 0) + tax))
  }
  if (taxByRate.size === 0) return null

  const buckets = Array.from(taxByRate.entries())
    .map(([rate, tax]) => ({ rate, net: roundOre(tax / (rate / 100)), tax }))
    .sort((a, b) => b.net - a.net)
  const tolerance = roundOre(sumOre(buckets.map((b) => VAT_ROUNDING_PER_RATE / (b.rate / 100))))
  const remainder = roundOre(amount - sumOre(buckets.flatMap((b) => [b.net, b.tax])))
  if (Math.abs(remainder) > tolerance) return null
  buckets[0].net = roundOre(buckets[0].net + remainder)
  return buckets.sort((a, b) => b.rate - a.rate)
}

/** The import row for a parsed sale or return, held for `hold` or bookable. */
function finalRow(parsed: KustomEntry, hold: KustomHoldReason | null): WebshopOrderUpsert {
  const vat = parsed.vat
  if (parsed.kind === 'sale') {
    const bookable = hold === null && vat !== null
    return {
      ...parsed.row,
      // is_paid false keeps every booking door from posting a row whose
      // accounts would be a guess; the title says why.
      status: bookable ? 'paid' : 'needs_review',
      is_paid: bookable,
      total_tax: vat === null ? 0 : sumOre(vat.map((b) => b.tax)),
      vat_breakdown: vat ?? [],
      payment_method_title: hold ? HOLD_TITLES[hold] : vat === null ? HOLD_TITLES.vat : 'Kustom',
    }
  }
  // A refund's total is negative; its buckets are signed against the row, as
  // the Shopify and WooCommerce refunds and buildOrderBooking read them: a
  // positive bucket reverses revenue and VAT. A held return keeps no split,
  // so bulk and day booking refuse it and the single dialog shows its lines.
  const split = hold === null ? vat : null
  return {
    ...parsed.row,
    status: 'refund',
    is_paid: true,
    total_tax: vat === null ? 0 : -sumOre(vat.map((b) => b.tax)),
    vat_breakdown: split ?? [],
    payment_method_title: hold ? HOLD_TITLES[hold] : 'Kustom',
  }
}

/**
 * The rows to import from a read report. A row whose order number the shop's
 * own feed (WooCommerce, Shopify) already has on the Orders page is held as
 * 'elsewhere': a shop selling through Kustom Checkout gets the same sale from
 * its store and from the settlement report, and booking both doubles the
 * revenue and the VAT.
 */
export function kustomImport(
  file: KustomSettlementFile,
  knownElsewhere: ReadonlySet<string> = new Set(),
): KustomSettlementReport {
  const rows: WebshopOrderUpsert[] = []
  let salesHeld = 0
  let returnsHeld = 0
  const leftOut: number[] = []
  for (const p of file.entries) {
    const hold =
      p.hold ?? (knownElsewhere.has(p.row.order_number) ? 'elsewhere' : p.vat === null ? 'vat' : null)
    if (p.kind === 'return' && hold !== null && LEFT_OUT_REASONS.has(hold)) {
      leftOut.push(p.amount)
      continue
    }
    if (hold !== null) {
      if (p.kind === 'sale') salesHeld += 1
      else returnsHeld += 1
    }
    rows.push(finalRow(p, hold))
  }
  return {
    payout: file.payout,
    rows,
    salesHeld,
    returnsHeld,
    returnsLeftOut: { count: leftOut.length, total: sumOre(leftOut) },
  }
}

/**
 * Read one Kustom settlement report. Pure: the caller asks the Orders page
 * for the order numbers it already has (kustomOrderNumbers), builds the rows
 * with kustomImport, writes them with upsertWebshopOrders and shows the
 * payout.
 */
export function parseKustomSettlementReport(content: string): KustomSettlementOutcome {
  const text = content.replace(/^﻿/, '')
  const { records } = splitCsvRecords(text, detectDelimiter(text))
  const normalized = records.map((r) => r.map((f) => f.trim()))

  const summaryAt = normalized.findIndex((r) => r.includes('total_settlement_amount'))
  const headerAt = normalized.findIndex((r) => r.includes('type') && r.includes('amount'))
  if (summaryAt < 0 || headerAt < 0 || headerAt <= summaryAt + 1) {
    return { ok: false, code: 'KUSTOM_SETTLEMENT_NOT_RECOGNIZED' }
  }
  const summary = toRecord(normalized[summaryAt], normalized[summaryAt + 1])
  const header = normalized[headerAt]
  const merchantId = cell(summary, 'merchant_id')
  if (!merchantId || !header.includes('capture_date')) {
    return { ok: false, code: 'KUSTOM_SETTLEMENT_NOT_RECOGNIZED' }
  }
  if (!header.includes('tax_rate_1') || !header.includes('tax_amount_1')) {
    return { ok: false, code: 'KUSTOM_SETTLEMENT_NO_CONSUMER_VAT' }
  }
  const inStoreColumns = header.filter((name) => name.startsWith('ipp_'))

  const transactions = normalized.slice(headerAt + 1).map((fields) => toRecord(header, fields))

  // One decimal mark for the whole file, proven by its cells: the portal's
  // minor-units format ("95840") proves none and is refused rather than read
  // as kronor.
  const summaryColumns = [
    'total_sale_amount',
    'total_return_amount',
    'total_reversal_amount',
    'total_fee_amount',
    'total_tax_amount',
    'total_holdback_amount',
    'total_release_amount',
    'total_settlement_amount',
  ]
  const vatAmountColumns = Array.from({ length: CONSUMER_VAT_PAIRS }, (_, i) => `tax_amount_${i + 1}`)
  const amountCells = [
    ...summaryColumns.map((name) => cell(summary, name)),
    ...transactions.flatMap((t) => [cell(t, 'amount'), ...vatAmountColumns.map((name) => cell(t, name))]),
  ]
  const decimalMark = inferDecimalMark(amountCells)
  if (decimalMark === null) return { ok: false, code: 'KUSTOM_SETTLEMENT_AMOUNT_FORMAT' }
  const amountOf = (value: string): number | null => {
    if (value === '') return 0
    const parsed = parseSwedishAmount(value, decimalMark)
    return parsed === null ? null : Math.abs(parsed)
  }

  const totals: Record<string, number> = {}
  for (const name of summaryColumns) {
    const value = amountOf(cell(summary, name))
    if (value === null) return { ok: false, code: 'KUSTOM_SETTLEMENT_AMOUNT_FORMAT' }
    totals[name] = value
  }
  // A payout can be negative (Kustom then pays nothing and books a debt), so
  // the settlement keeps its sign; the totals are amounts and never do.
  const settlementSigned = parseSwedishAmount(cell(summary, 'total_settlement_amount'), decimalMark) ?? 0
  const payoutDateCell = cell(summary, 'payout_date').slice(0, 10)
  if (payoutDateCell && !isSaneDateString(payoutDateCell)) return { ok: false, code: 'KUSTOM_SETTLEMENT_DATE_FORMAT' }
  const settlementCurrency = (cell(summary, 'settlement_currency') || 'SEK').toUpperCase()
  const reference = cell(summary, 'payment_reference') || null

  const entries: KustomEntry[] = []
  const seen = new Set<string>()
  const saleAmounts: number[] = []
  const returnAmounts: number[] = []

  for (const t of transactions) {
    const type = cell(t, 'type').toUpperCase()
    if (type !== 'SALE' && type !== 'RETURN') continue
    const kind = type === 'SALE' ? 'sale' : 'return'

    const amount = amountOf(cell(t, 'amount'))
    if (amount === null) return { ok: false, code: 'KUSTOM_SETTLEMENT_AMOUNT_FORMAT' }
    const capturedOn = swedishDayOf(cell(t, 'capture_date'))
    if (capturedOn === null) return { ok: false, code: 'KUSTOM_SETTLEMENT_DATE_FORMAT' }
    const id = kind === 'sale' ? cell(t, 'capture_id') : cell(t, 'refund_id')
    if (!id) return { ok: false, code: 'KUSTOM_SETTLEMENT_ID_COLUMNS_MISSING' }
    const externalId = kind === 'sale' ? kustomCaptureExternalId(merchantId, id) : kustomRefundExternalId(merchantId, id)
    if (seen.has(externalId)) return { ok: false, code: 'KUSTOM_SETTLEMENT_DUPLICATE_ROW' }
    seen.add(externalId)

    const pairs: Array<{ rate: number; tax: number }> = []
    for (let i = 1; i <= CONSUMER_VAT_PAIRS; i++) {
      const tax = amountOf(cell(t, `tax_amount_${i}`))
      if (tax === null) return { ok: false, code: 'KUSTOM_SETTLEMENT_AMOUNT_FORMAT' }
      if (tax === 0) continue
      const basisPoints = Number(cell(t, `tax_rate_${i}`))
      pairs.push({ rate: Number.isInteger(basisPoints) ? basisPoints / 100 : Number.NaN, tax })
    }

    // Where the goods went: the shipping country when the report has it.
    // purchase_country is Kustom's purchase country, or the merchant's when
    // the order had none, so it only ever stands in for Sweden-or-not.
    const country = (cell(t, 'shipping_address_country') || cell(t, 'purchase_country')).toUpperCase() || null
    const inStore = inStoreColumns.some((name) => cell(t, name) !== '')
    const hold: KustomHoldReason | null = inStore
      ? 'in_store'
      : country !== null && country !== COUNTRY_SWEDEN
        ? 'abroad'
        : null

    const orderId = cell(t, 'order_id')
    const saleDate = cell(t, 'sale_date')
    entries.push({
      kind,
      amount,
      vat: vatBreakdownOf(amount, pairs),
      hold,
      row: {
        platform: 'kustom',
        store_scope: merchantId,
        store_label: `Kustom ${merchantId}`,
        connection_id: null,
        row_type: kind === 'sale' ? 'order' : 'refund',
        parent_external_id: null,
        external_id: externalId,
        platform_order_id: orderId || id,
        order_number: cell(t, 'merchant_reference1') || cell(t, 'short_order_id') || orderId || id,
        status: '',
        is_paid: false,
        // A return is dated when it was registered, not by its original sale.
        order_date:
          kind === 'sale' ? (swedishDayOf(saleDate) ?? (isSaneDateString(saleDate) ? saleDate : capturedOn)) : capturedOn,
        paid_date: capturedOn,
        currency: (cell(t, 'posting_currency') || settlementCurrency).toUpperCase(),
        total: kind === 'sale' ? amount : -amount,
        total_tax: 0,
        vat_breakdown: [],
        line_items: [],
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_orgnr: null,
        customer_country: country,
        payment_method: 'kustom',
        payment_method_title: null,
        gateway_reference: reference,
        refunded_total: 0,
      },
    })
    ;(kind === 'sale' ? saleAmounts : returnAmounts).push(amount)
  }

  if (
    !equalOre(sumOre(saleAmounts), totals.total_sale_amount) ||
    !equalOre(sumOre(returnAmounts), totals.total_return_amount)
  ) {
    return { ok: false, code: 'KUSTOM_SETTLEMENT_TOTALS_MISMATCH' }
  }

  const named = roundOre(
    totals.total_sale_amount -
      totals.total_return_amount -
      totals.total_reversal_amount -
      totals.total_fee_amount -
      totals.total_tax_amount -
      totals.total_holdback_amount +
      totals.total_release_amount,
  )
  const payout: KustomPayout = {
    reference,
    merchantId,
    payoutDate: payoutDateCell || null,
    currency: settlementCurrency,
    sales: totals.total_sale_amount,
    returns: totals.total_return_amount,
    reversals: totals.total_reversal_amount,
    fees: totals.total_fee_amount,
    feeVat: totals.total_tax_amount,
    holdback: totals.total_holdback_amount,
    release: totals.total_release_amount,
    other: roundOre(settlementSigned - named),
    settlement: settlementSigned,
  }
  return { ok: true, file: { payout, entries } }
}

/** The order numbers of a report's rows, to look up on the Orders page. */
export function kustomOrderNumbers(file: KustomSettlementFile): string[] {
  return Array.from(new Set(file.entries.map((e) => e.row.order_number)))
}
