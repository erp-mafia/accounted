/**
 * Register a customer invoice that is already in the books (crm#1094).
 *
 * A company that moves to Accounted with an SIE file brings its verifikat but
 * not its kundreskontra: SIE carries no open items, so 1510 holds a balance no
 * invoice in the register explains. The provider migrations fill the register
 * from the old system's API and link each invoice to the SIE verifikat that
 * booked it (link-migrated-registration-vouchers.ts). Without such an
 * integration the only door was the one for invoices Accounted issues itself:
 * a draft that gets a new F-number and a new verifikat when it is sent, which
 * books the revenue and the VAT a second time.
 *
 * This is the missing door to the migration's end state, one invoice at a
 * time, for an agent reading the reskontra from a PDF:
 *
 *  - the invoice keeps the number printed on it: the löpnummer the customer
 *    received (ML 17 kap 24 §) and the one the verifikat text refers to;
 *  - it links the verifikat that booked it (invoices.journal_entry_id) after
 *    the corroboration the migration linker requires: posted, not already
 *    another invoice's verifikat, and a net debit on 151x equal to the total;
 *  - nothing is written to the journal. Subtotal, VAT and treatment are read
 *    from that verifikat, so the row says what the books say. A registration
 *    has no lines, so a later kreditfaktura reverses it from the header
 *    (buildCreditNoteLines' fallback): the whole subtotal on the one revenue
 *    account of its treatment, the VAT on that rate's 26xx account. These
 *    shapes, which that reversal cannot return to the momsdeklaration boxes
 *    the sale was declared in, are refused: VAT at several rates; VAT more
 *    than 1 kr off its rate of the rest of the sale (an untaxed part);
 *    momsfri revenue (ruta 42) or zero-rated revenue next to VAT, or momsfri
 *    next to zero-rated; goods sold abroad; VAT on the margin (VMB); vilande
 *    moms; a ROT/RUT share on 1513;
 *  - a partly paid invoice carries paid_amount = total - remaining, and the
 *    part already paid is one invoice_payments row dated the reskontra's
 *    date (balance_as_of), without a verifikat: the as-of reskontra reads
 *    payment rows as authoritative, so without it a later payment would
 *    reopen that part at every historical date;
 *  - faktureringsmetoden only. Under kontantmetoden the payment of an open
 *    invoice books its revenue and VAT, and every payment flow takes the
 *    accrual path once journal_entry_id is set (kontantmetod-cutoff.ts), so
 *    a link would leave the sale unbooked.
 *
 * An invoice already in the register under that number, with no verifikat
 * (invoices.journal_entry_id null), is the same door's other end (crm#1302):
 * a provider migration that wrote the row but never linked it leaves an
 * invoice that reads as unbooked while its sale is in the books, and
 * booking it would book the revenue and the VAT a second time. When that row
 * is this invoice (same customer, currency and total; issued, never a draft
 * or a cancelled row) and the verifikat passes every rule above, the
 * registration links the row instead of inserting one: journal_entry_id from
 * null, nothing else. Its lines, VAT and payments are the row's own and stay
 * as they are, so the voucher-shape rules that guard a header-only row do
 * not apply; its kronor must equal what the verifikat books on 151x, the
 * migration linker's rule (link-migrated-registration-vouchers.ts).
 *
 * No invoice_items are written, on purpose: invoice-register-coverage.ts
 * reads "linked to a verifikat, no lines" as an invoice registered from the
 * books, one open item of an older history, so registrations never move the
 * register's coverage boundary.
 *
 * A foreign-currency invoice (#90, crm#1336) registers against a verifikat
 * whose 151x lines carry its currency and its amount in it, as the
 * engine's own invoice verifikat do. The verifikat is then the record for
 * both: the caller's total, stated in the invoice's currency, must be what
 * 151x carries in it, and the rate is not the caller's but the one that
 * gives the booked kronor back (rateGivingBack, the rule a migrated foreign
 * invoice follows, crm#1039). The kronor columns are the verifikat's own,
 * so the row behaves like any foreign invoice: a payment clears 151x at
 * that rate, the revaluation measures from it, a kreditfaktura reverses the
 * booked kronor. A verifikat in kronor only says neither the invoice's own
 * amount nor its rate, and is refused.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm, isPastDue } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { NON_ISSUED_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { statedVatFitsRate } from '@/lib/bookkeeping/gross-split'
import { ledgerLineAmountIn } from '@/lib/bookkeeping/ledger-line-amount'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import { FOREIGN_CURRENCIES, type InvoiceStatus, type VatTreatment } from '@/types'
import { recordInvoicePaymentRow } from './invoice-payment-row'
import { seriesNumberOf } from '@/lib/company/invoice-number-series'
import { REGISTER_BOOKED_INVOICE_MODE } from './register-booked-invoice-mode'
import {
  rateGivingBack,
  refineRegistrationDatesAndAmounts,
  registeredAmountSchema,
  registrationVoucherLabel,
  reskontraCurrencySchema,
  voucherCorroborationWarnings,
} from './register-booked-rules'
import { remindersActiveFor } from './reminders-enabled'
import {
  DOMESTIC_REVERSE_CHARGE_NOTICE,
  EU_REVERSE_CHARGE_NOTICE,
  EXPORT_NOTICE_SV,
} from './vat-rules'

const log = createLogger('register-booked-invoice')

export type RegisterBookedInvoiceErrorCode =
  | 'CUSTOMER_NOT_FOUND'
  | 'INVOICE_REGISTER_CASH_METHOD'
  | 'INVOICE_REGISTER_NUMBER_TAKEN'
  | 'INVOICE_REGISTER_NUMBER_IN_SERIES'
  | 'INVOICE_REGISTER_VOUCHER_NOT_FOUND'
  | 'INVOICE_REGISTER_VOUCHER_NOT_POSTED'
  | 'INVOICE_REGISTER_OPENING_BALANCE'
  | 'INVOICE_REGISTER_VOUCHER_TAKEN'
  | 'INVOICE_REGISTER_VOUCHER_NOT_SALE'
  | 'INVOICE_REGISTER_VOUCHER_UNSUPPORTED'
  | 'INVOICE_REGISTER_AMOUNT_MISMATCH'
  | 'INVOICE_REGISTER_FOREIGN_CURRENCY'

/** BAS 1510-1519 Kundfordringar: the verifikat of a customer invoice debits it. */
const AR_ACCOUNT_PREFIX = '151'

/** BAS 1513: the Skatteverket share of a ROT/RUT invoice (fakturamodellen). */
const ROT_RUT_RECEIVABLE_ACCOUNT = '1513'

/**
 * Utgående moms on a sale, by rate: 261x, 262x, 263x. The x4 accounts
 * (omvänd betalningsskyldighet, ruta 30-32) and x5 accounts (import, ruta
 * 60-62) hold VAT a buyer self-assesses on a purchase, never a sale's. The
 * x8 accounts hold vilande utgående moms, which the kontantmetod year-end
 * books for invoices still unpaid: never an invoice verifikat's own VAT. The
 * x6 accounts hold VAT under vinstmarginalbeskattning (2616, 2626, 2636),
 * charged on the margin, not on the price: a header-only kreditfaktura would
 * reverse the price as an ordinary sale in ruta 05.
 */
const OUTPUT_VAT_RATE_BY_PREFIX: Readonly<Record<string, 25 | 12 | 6>> = { '261': 25, '262': 12, '263': 6 }
const PURCHASE_SIDE_VAT_DIGITS = new Set(['4', '5'])
const VILANDE_VAT_DIGIT = '8'
const MARGIN_SCHEME_VAT_DIGIT = '6'
const TREATMENT_BY_RATE = { 25: 'standard_25', 12: 'reduced_12', 6: 'reduced_6' } as const satisfies Record<25 | 12 | 6, VatTreatment>

/**
 * The momsfri revenue accounts of ruta 42 (3004, 3100, 3404, 3980, 3994),
 * read from the declaration's own map so the two cannot drift. Alone they are
 * a momsfri sale, which reverses onto 3004 or 3100 in the same ruta; next to
 * VAT or zero-rated revenue the header holds one treatment for both parts.
 * Built on first use, not at import: modules that only import this file (and
 * tests that mock the declaration module) never need the map.
 */
let exemptRevenueAccountSet: ReadonlySet<string> | null = null
function exemptRevenueAccounts(): ReadonlySet<string> {
  exemptRevenueAccountSet ??= new Set(
    Object.entries(ACCOUNT_RUTA)
      .filter(([, mapping]) => mapping.box === 'ruta42')
      .map(([account]) => account),
  )
  return exemptRevenueAccountSet
}

interface ZeroRatedSale {
  treatment: VatTreatment
  momsRuta: string
  notice: string | null
}

/**
 * The zero-rated sale a BAS revenue account books (rutor 39-41), with the
 * moms_ruta and statutory notice a native invoice of that treatment carries
 * (vat-rules.ts; read per call, never at module load). Only these reverse
 * onto their own account through getRevenueAccount(vat_treatment). Goods
 * sold abroad (3105 export, 3108 unionsintern leverans) reverse on their
 * goods account only with a delivery country the verifikat does not give,
 * and trepartshandel (3107) has no treatment at all: those are refused.
 */
function zeroRatedSaleOn(account: string): ZeroRatedSale | null {
  switch (account) {
    case '3305':
      return { treatment: 'export', momsRuta: '40', notice: EXPORT_NOTICE_SV }
    case '3308':
      return { treatment: 'reverse_charge', momsRuta: '39', notice: EU_REVERSE_CHARGE_NOTICE }
    case '3231':
      return { treatment: 'reverse_charge_domestic', momsRuta: '41', notice: DOMESTIC_REVERSE_CHARGE_NOTICE }
    // Omvänd betalningsskyldighet for other than byggtjänster: the
    // byggtjänster notice would misstate the supply, so none is stamped.
    case '3232':
    case '3233':
      return { treatment: 'reverse_charge_domestic', momsRuta: '41', notice: null }
    default:
      return null
  }
}
const GOODS_ABROAD_REVENUE = new Set(['3105', '3107', '3108'])

/** journal_entries.source_type of entries that never book a customer invoice. */
const NOT_A_SALE_SOURCE_TYPES = new Set(['year_end', 'storno'])

const commonShape = {
  customer_id: z.string().uuid(),
  invoice_number: z.string().trim().min(1).max(64),
  invoice_date: saneIsoDateSchema,
  due_date: saneIsoDateSchema,
  journal_entry_id: z.string().uuid(),
  /** In the invoice's currency, as are remaining_amount and the paid part. */
  total: registeredAmountSchema,
  /** The reskontra's own date: what the remaining balance is stated as of. */
  balance_as_of: saneIsoDateSchema.optional(),
  /** The invoice's currency per the reskontra; SEK when left out. */
  currency: reskontraCurrencySchema.optional(),
}

/** The tool's arguments: remaining_amount defaults to the total (unpaid). */
export const RegisterBookedInvoiceInputSchema = z
  .object({ ...commonShape, remaining_amount: registeredAmountSchema.optional() })
  .strict()
  .superRefine(refineRegistrationDatesAndAmounts)

/** The staged params: the input with remaining_amount resolved, under the create_invoice pending type. */
export const RegisterBookedInvoiceParamsSchema = z
  .object({ mode: z.literal(REGISTER_BOOKED_INVOICE_MODE), ...commonShape, remaining_amount: registeredAmountSchema })
  .strict()
  .superRefine(refineRegistrationDatesAndAmounts)

export type RegisterBookedInvoiceInput = z.infer<typeof RegisterBookedInvoiceParamsSchema>

/** The staged params for a validated input. */
export function toRegisterBookedInvoiceParams(
  input: z.infer<typeof RegisterBookedInvoiceInputSchema>,
): RegisterBookedInvoiceInput {
  return { mode: REGISTER_BOOKED_INVOICE_MODE, ...input, remaining_amount: input.remaining_amount ?? input.total }
}

export interface BookedInvoiceVoucherLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  currency?: string | null
  /** The line's amount in `currency` (a magnitude; the side is the debit/credit one). */
  amount_in_currency?: number | string | null
  exchange_rate?: number | string | null
  line_description?: string | null
}

/** Net debit on Kundfordringar (151x): what the verifikat says the customer owes. */
export function receivableNetDebit(lines: readonly BookedInvoiceVoucherLine[]): number {
  let net = 0
  for (const line of lines) {
    if (!String(line.account_number).startsWith(AR_ACCOUNT_PREFIX)) continue
    net = roundOre(net + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0))
  }
  return net
}

/** The first non-SEK currency on a 151x line, or null when the receivable is booked in kronor. */
export function receivableForeignCurrency(lines: readonly BookedInvoiceVoucherLine[]): string | null {
  for (const line of lines) {
    if (!String(line.account_number).startsWith(AR_ACCOUNT_PREFIX)) continue
    const currency = line.currency?.trim().toUpperCase()
    if (currency && currency !== 'SEK') return currency
  }
  return null
}

/** Net credit of a verifikat line, to the öre. */
const netCredit = (line: BookedInvoiceVoucherLine) =>
  roundOre((Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0))

/**
 * What the verifikat's 151x lines carry in `currency`: the net debit in it
 * and the one rate they name (null when they name none or several). Null
 * when a 151x line that moves kronor carries no amount in `currency`: the
 * verifikat does not say what the invoice is in that currency.
 */
export function receivableInCurrency(
  lines: readonly BookedInvoiceVoucherLine[],
  currency: string,
): { amount: number; statedRate: number | null } | null {
  let amount = 0
  const rates = new Set<number>()
  for (const line of lines) {
    if (!String(line.account_number).startsWith(AR_ACCOUNT_PREFIX)) continue
    if (Math.abs(netCredit(line)) <= ORE_TOLERANCE) continue
    const signed = ledgerLineAmountIn(line, currency)
    if (signed === null) return null
    amount = roundOre(amount + signed)
    const rate = Number(line.exchange_rate)
    if (line.exchange_rate != null && Number.isFinite(rate) && rate > 0) rates.add(rate)
  }
  return { amount, statedRate: rates.size === 1 ? [...rates][0] : null }
}

/**
 * The output VAT the sale's lines carry in `currency`: the 261x-263x lines
 * deriveInvoiceVatFromVoucher counts, or null when one of them carries no
 * amount in it (the engine stamps the currency on 151x only).
 */
function outputVatInCurrency(lines: readonly BookedInvoiceVoucherLine[], currency: string): number | null {
  let vat = 0
  for (const line of lines) {
    const account = String(line.account_number)
    if (!OUTPUT_VAT_RATE_BY_PREFIX[account.slice(0, 3)] || PURCHASE_SIDE_VAT_DIGITS.has(account.charAt(3))) continue
    if (Math.abs(netCredit(line)) <= ORE_TOLERANCE) continue
    const signed = ledgerLineAmountIn(line, currency)
    if (signed === null) return null
    vat = roundOre(vat - signed)
  }
  return vat
}

export interface DerivedInvoiceVat {
  subtotal: number
  vatAmount: number
  vatRate: 25 | 12 | 6 | 0
  vatTreatment: VatTreatment
  /** The ruta a native invoice of this treatment states (invoices.moms_ruta); null for a momsfri sale. */
  momsRuta: string | null
  /** The statutory notice a native invoice of this treatment carries, and its kreditfaktura repeats. */
  reverseChargeText: string | null
}

/** A sale the header-only registration cannot hold (see the module header). */
export type UnsupportedVoucherShape =
  | 'mixed_vat_rates'
  | 'vat_not_rate_of_subtotal'
  | 'zero_rated_with_vat'
  | 'mixed_zero_rated'
  | 'mixed_exempt'
  | 'goods_abroad'
  | 'margin_scheme_vat'
  | 'vilande_vat'

export type DerivedVoucherVat =
  | { ok: true; vat: DerivedInvoiceVat }
  | { ok: false; reason: 'implausible_vat' | UnsupportedVoucherShape }

/**
 * Subtotal, VAT, rate and treatment of the invoice, from the verifikat that
 * booked it: the net credit on the output VAT accounts, and for a sale
 * without output VAT the zero-rated revenue account it books (3308 EU
 * services, 3305 export services, 323x omvänd betalningsskyldighet), else
 * momsfri. Refused when the VAT is not plausible for a sale of `total`
 * (negative, or not below the total) or the sale has a shape the header
 * alone cannot carry into a kreditfaktura: a taxed sale must be all taxed at
 * its one rate (the VAT within 1 kr of that rate of the rest), and momsfri
 * revenue (ruta 42) must stand alone.
 */
export function deriveInvoiceVatFromVoucher(
  lines: readonly BookedInvoiceVoucherLine[],
  total: number,
): DerivedVoucherVat {
  const vatByRate = new Map<25 | 12 | 6, number>()
  const zeroRated = new Map<VatTreatment, ZeroRatedSale>()
  let goodsAbroad = false
  let exemptRevenue = false
  for (const line of lines) {
    const account = String(line.account_number)
    const net = netCredit(line)
    if (Math.abs(net) <= ORE_TOLERANCE) continue
    const rate = OUTPUT_VAT_RATE_BY_PREFIX[account.slice(0, 3)]
    if (rate) {
      const digit = account.charAt(3)
      if (digit === VILANDE_VAT_DIGIT) return { ok: false, reason: 'vilande_vat' }
      if (digit === MARGIN_SCHEME_VAT_DIGIT) return { ok: false, reason: 'margin_scheme_vat' }
      if (PURCHASE_SIDE_VAT_DIGITS.has(digit)) continue
      vatByRate.set(rate, roundOre((vatByRate.get(rate) ?? 0) + net))
      continue
    }
    if (GOODS_ABROAD_REVENUE.has(account)) goodsAbroad = true
    if (exemptRevenueAccounts().has(account)) exemptRevenue = true
    const zero = zeroRatedSaleOn(account)
    if (zero) zeroRated.set(zero.treatment, zero)
  }

  const booked = [...vatByRate.entries()].filter(([, amount]) => Math.abs(amount) > ORE_TOLERANCE)
  const vatAmount = roundOre(booked.reduce((sum, [, amount]) => sum + amount, 0))
  if (vatAmount < 0 || vatAmount >= total) return { ok: false, reason: 'implausible_vat' }
  if (goodsAbroad) return { ok: false, reason: 'goods_abroad' }
  if (booked.length > 1) return { ok: false, reason: 'mixed_vat_rates' }

  if (booked.length === 1) {
    if (zeroRated.size > 0) return { ok: false, reason: 'zero_rated_with_vat' }
    if (exemptRevenue) return { ok: false, reason: 'mixed_exempt' }
    const [rate] = booked[0]
    const subtotal = roundOre(total - vatAmount)
    // The kreditfaktura reverses the whole subtotal as sold at this rate, so
    // the VAT must be that rate of it. Further off, part of the sale carried
    // no VAT, and the reversal would take it out of ruta 05 although it was
    // never declared there.
    if (!statedVatFitsRate(vatAmount, subtotal, rate / 100)) {
      return { ok: false, reason: 'vat_not_rate_of_subtotal' }
    }
    return {
      ok: true,
      vat: {
        subtotal,
        vatAmount,
        vatRate: rate,
        vatTreatment: TREATMENT_BY_RATE[rate],
        momsRuta: '05',
        reverseChargeText: null,
      },
    }
  }

  if (zeroRated.size > 1) return { ok: false, reason: 'mixed_zero_rated' }
  if (zeroRated.size === 1 && exemptRevenue) return { ok: false, reason: 'mixed_exempt' }
  const sale = [...zeroRated.values()][0]
  return {
    ok: true,
    vat: {
      subtotal: total,
      vatAmount: 0,
      vatRate: 0,
      vatTreatment: sale?.treatment ?? 'exempt',
      momsRuta: sale?.momsRuta ?? null,
      reverseChargeText: sale?.notice ?? null,
    },
  }
}

/** "a, b or c". */
const orList = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items.join('')

const UNSUPPORTED_SHAPE_TEXT: Record<UnsupportedVoucherShape | 'rot_rut', string> = {
  mixed_vat_rates: 'books output VAT at more than one rate',
  vat_not_rate_of_subtotal: 'books output VAT that is not its rate of the rest of the sale (more than 1 kr off), as when part of the sale carries no VAT',
  zero_rated_with_vat: 'books zero-rated revenue (EU, export or omvänd betalningsskyldighet) next to output VAT',
  mixed_zero_rated: 'books revenue under more than one zero-rated treatment',
  get mixed_exempt() {
    return `books momsfri revenue (ruta 42: ${orList([...exemptRevenueAccounts()])}) next to output VAT or zero-rated revenue`
  },
  goods_abroad: 'books goods sold abroad or in trepartshandel (3105, 3107 or 3108)',
  margin_scheme_vat: 'books VAT under vinstmarginalbeskattning (2616, 2626 or 2636), VAT on the margin rather than the price',
  vilande_vat: 'books vilande utgående moms (2618, 2628 or 2638), the kontantmetod year-end\'s VAT',
  rot_rut: 'books a ROT/RUT share on 1513',
}

export interface BookedInvoiceWarning {
  code: 'REGISTER_VOUCHER_TEXT' | 'REGISTER_VOUCHER_DATE' | 'REGISTER_OVERDUE_NOT_REMINDED'
  message_sv: string
  message_en: string
}

export interface BookedInvoicePlan {
  customerName: string
  voucher: { journalEntryId: string; label: string; entryDate: string; description: string | null }
  /**
   * Set when the register already holds this invoice without its verifikat
   * (see the module header): the registration links that row and writes no
   * other column. Every amount and the status below are then the row's.
   */
  linksInvoiceId: string | null
  /** The invoice's dates: the caller's for a new row, the row's own when linked. */
  invoiceDate: string
  dueDate: string
  /** 'sent' or 'partially_paid' for a new row; a linked row keeps its own. */
  status: InvoiceStatus
  /** The invoice's own currency: total, subtotal, vatAmount and the paid and remaining parts are in it. */
  currency: string
  /** The rate that gives the booked kronor back; null for SEK. */
  exchangeRate: number | null
  /** What the verifikat books, in kronor; for SEK the same as the amounts above. */
  totalSek: number
  subtotalSek: number
  vatAmountSek: number
  total: number
  subtotal: number
  vatAmount: number
  vatRate: number
  vatTreatment: VatTreatment
  momsRuta: string | null
  reverseChargeText: string | null
  paidAmount: number
  remainingAmount: number
  /** The reskontra date the part already paid is dated to; null when nothing is paid. */
  paidAsOf: string | null
  warnings: BookedInvoiceWarning[]
}

export interface BookedInvoiceRefusal {
  ok: false
  code: RegisterBookedInvoiceErrorCode
  /** English, naming what the registry sentence cannot (which verifikat, which amounts). */
  message: string
  details?: Record<string, unknown>
}

const refuse = (
  code: RegisterBookedInvoiceErrorCode,
  message: string,
  details?: Record<string, unknown>,
): BookedInvoiceRefusal => ({ ok: false, code, message, ...(details ? { details } : {}) })

/** The invoice the number already names, as far as linking it needs. */
interface RegisteredRow {
  id: string
  customer_id: string | null
  invoice_date: string
  due_date: string
  status: InvoiceStatus | null
  document_type: string | null
  currency: string | null
  exchange_rate: number | string | null
  total: number | string
  total_sek: number | string | null
  subtotal: number | string
  subtotal_sek: number | string | null
  vat_amount: number | string
  vat_amount_sek: number | string | null
  vat_rate: number | string | null
  vat_treatment: VatTreatment | null
  moms_ruta: string | null
  reverse_charge_text: string | null
  paid_amount: number | string | null
  remaining_amount: number | string | null
  journal_entry_id: string | null
}

/** A row the registration may link: issued, so its status is known. */
type LinkableRow = RegisteredRow & { status: InvoiceStatus }

interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string | null
  status: string
  source_type: string | null
}

/**
 * Every rule of the registration, read-only. The staging tool runs it for the
 * preview and the commit runs it again, so a verifikat reversed, or a number
 * or verifikat claimed, between staging and approval is refused at approval.
 */
export async function planBookedInvoiceRegistration(
  supabase: SupabaseClient,
  companyId: string,
  input: RegisterBookedInvoiceInput,
  options: { today?: string } = {},
): Promise<{ ok: true; plan: BookedInvoicePlan } | BookedInvoiceRefusal> {
  const [customerRes, settingsRes, numberRes, voucherRes, linesRes, holderRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, name, email')
      .eq('id', input.customer_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('company_settings')
      .select('invoice_prefix, next_invoice_number, send_invoice_reminders, accounting_method')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('invoices')
      .select('id, customer_id, invoice_date, due_date, status, document_type, currency, exchange_rate, total, total_sek, subtotal, subtotal_sek, vat_amount, vat_amount_sek, vat_rate, vat_treatment, moms_ruta, reverse_charge_text, paid_amount, remaining_amount, journal_entry_id')
      .eq('company_id', companyId)
      .eq('invoice_number', input.invoice_number)
      .limit(1),
    supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, entry_date, description, status, source_type')
      .eq('id', input.journal_entry_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    // Read with the entry, used only once the entry is known to be this company's.
    supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, currency, amount_in_currency, exchange_rate, line_description')
      .eq('journal_entry_id', input.journal_entry_id),
    supabase
      .from('invoices')
      .select('id, invoice_number')
      .eq('company_id', companyId)
      .eq('journal_entry_id', input.journal_entry_id)
      .limit(1),
  ])
  for (const res of [customerRes, settingsRes, numberRes, voucherRes, linesRes, holderRes]) {
    if (res.error) throw dbError(res.error)
  }

  const settings = settingsRes.data as {
    invoice_prefix: string | null
    next_invoice_number: number | null
    send_invoice_reminders: boolean | null
    accounting_method: string | null
  } | null
  if (settings?.accounting_method === 'cash') {
    return refuse(
      'INVOICE_REGISTER_CASH_METHOD',
      'The company uses kontantmetoden: an open invoice\'s revenue and VAT are booked when it is paid, so it cannot be linked to a verifikat. Registering open invoices is supported under faktureringsmetoden only, for now.',
    )
  }
  const currency = input.currency ?? 'SEK'
  const inKronor = isLedgerCurrency(currency)
  if (!inKronor && !(FOREIGN_CURRENCIES as readonly string[]).includes(currency)) {
    return refuse(
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
      `The invoice is in ${currency}, which Accounted does not invoice in (SEK, ${FOREIGN_CURRENCIES.join(', ')}). Leave it out of the register.`,
      { currency },
    )
  }

  const customer = customerRes.data as { id: string; name: string | null; email: string | null } | null
  if (!customer) {
    return refuse('CUSTOMER_NOT_FOUND', `Customer not found: no customer with id ${input.customer_id} in this company.`)
  }

  const numberTaken = (id: string) => refuse(
    'INVOICE_REGISTER_NUMBER_TAKEN',
    `Invoice number ${input.invoice_number} is already in the register (invoice_id ${id}).`,
    { invoice_id: id },
  )
  const taken = ((numberRes.data ?? []) as RegisteredRow[])[0]
  // The row the registration links instead of inserting one (crm#1302).
  let existing: LinkableRow | null = null
  if (taken) {
    // An issued invoice only: a draft has no verifikat
    // (invoices_draft_has_no_verifikat) and a cancelled row is no sale. A
    // null status reads as the column's default, draft.
    const status = taken.status ?? 'draft'
    if (taken.journal_entry_id || (NON_ISSUED_INVOICE_STATUSES as readonly string[]).includes(status) || (taken.document_type ?? 'invoice') !== 'invoice') {
      return numberTaken(taken.id)
    }
    const differs = [
      taken.customer_id !== input.customer_id ? `customer_id ${taken.customer_id}` : null,
      (taken.currency ?? 'SEK') !== currency ? `currency ${taken.currency ?? 'SEK'}` : null,
      Math.abs(Number(taken.total) - input.total) > ORE_TOLERANCE ? `total ${Number(taken.total)}` : null,
    ].filter((part): part is string => part !== null)
    if (differs.length > 0) {
      return refuse(
        'INVOICE_REGISTER_NUMBER_TAKEN',
        `Invoice number ${input.invoice_number} is already in the register (invoice_id ${taken.id}) without a verifikat, but it is not this invoice: it has ${differs.join(', ')}. Registering links that row only when customer, currency and total are the same.`,
        { invoice_id: taken.id },
      )
    }
    existing = { ...taken, status }
  }

  // Accounted issues invoice_prefix + next_invoice_number, padded to three
  // digits, and never skips a number that is taken. So an old number in that
  // series is one löpnummer with Accounted's spelling of it ("12" and "012"),
  // and one at or past the counter would be issued a second time later. The
  // counter is never moved here: only the user knows where the old series
  // ended, open items alone do not say. A row being linked keeps the number
  // it already holds, so the series is not asked.
  const inSeries = settings && !existing ? seriesNumberOf(input.invoice_number, settings.invoice_prefix) : null
  const nextNumber = Number(settings?.next_invoice_number ?? 1)
  if (inSeries !== null && inSeries >= nextNumber) {
    return refuse(
      'INVOICE_REGISTER_NUMBER_IN_SERIES',
      `Invoice number ${input.invoice_number} is in the series Accounted issues itself, which stands at ${nextNumber}: a later invoice would get the same number. Set next_invoice_number past the old series' last number (or an invoice_prefix for Accounted's own series) with gnubok_update_company_settings, then retry.`,
      { invoice_number: input.invoice_number, next_invoice_number: nextNumber, invoice_prefix: settings?.invoice_prefix ?? null },
    )
  }
  if (inSeries !== null) {
    const digits = String(inSeries)
    const issuedSpelling = `${settings?.invoice_prefix ?? ''}${digits.padStart(Math.max(3, digits.length), '0')}`
    if (issuedSpelling !== input.invoice_number) {
      const { data, error } = await supabase
        .from('invoices')
        .select('id')
        .eq('company_id', companyId)
        .eq('invoice_number', issuedSpelling)
        .limit(1)
      if (error) throw dbError(error)
      const issued = ((data ?? []) as { id: string }[])[0]
      if (issued) return numberTaken(issued.id)
    }
  }

  const voucher = voucherRes.data as VoucherRow | null
  if (!voucher) {
    return refuse('INVOICE_REGISTER_VOUCHER_NOT_FOUND', `Journal entry not found: no verifikat with id ${input.journal_entry_id} in this company.`)
  }
  const label = registrationVoucherLabel(voucher)
  if (voucher.status !== 'posted') {
    return refuse(
      'INVOICE_REGISTER_VOUCHER_NOT_POSTED',
      `Verifikat ${label} is ${voucher.status}, not posted: an invoice can only be registered against a posted verifikat.`,
      { status: voucher.status },
    )
  }
  // SIE carries an invoice from before the first imported year only inside
  // that year's opening balance: one entry with every receivable summed on
  // 1510, whose VAT lines are the year-end balances, not this invoice's.
  if (voucher.source_type === 'opening_balance') {
    return refuse(
      'INVOICE_REGISTER_OPENING_BALANCE',
      `Verifikat ${label} is an opening balance (ingående balans), not the verifikat that booked invoice ${input.invoice_number}. Import the SIE file of the year the invoice was booked in (oldest year first), then register the invoice against that year's verifikat.`,
    )
  }
  if (voucher.source_type && NOT_A_SALE_SOURCE_TYPES.has(voucher.source_type)) {
    return refuse(
      'INVOICE_REGISTER_VOUCHER_NOT_SALE',
      `Verifikat ${label} is a ${voucher.source_type === 'storno' ? 'storno' : 'year-end'} entry, not the verifikat of a customer invoice.`,
      { source_type: voucher.source_type },
    )
  }

  const holder = ((holderRes.data ?? []) as { id: string; invoice_number: string | null }[])[0]
  if (holder) {
    return refuse(
      'INVOICE_REGISTER_VOUCHER_TAKEN',
      `Verifikat ${label} already books invoice ${holder.invoice_number ?? holder.id} (invoice_id ${holder.id}).`,
      { invoice_id: holder.id },
    )
  }

  const lines = (linesRes.data ?? []) as BookedInvoiceVoucherLine[]
  const voucherCurrency = receivableForeignCurrency(lines)
  if (inKronor && voucherCurrency) {
    return refuse(
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
      `Verifikat ${label} books the receivable in ${voucherCurrency}: register it with currency ${voucherCurrency}, total and remaining_amount in ${voucherCurrency} as the reskontra lists them.`,
      { currency: voucherCurrency },
    )
  }
  const fx = inKronor ? null : receivableInCurrency(lines, currency)
  if (!inKronor && !fx) {
    return refuse(
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
      `Verifikat ${label} books the receivable ${voucherCurrency ? `in ${voucherCurrency}` : 'in kronor only'}, not in ${currency}: it says neither the invoice's ${currency} amount nor its rate, so it cannot be registered as a ${currency} invoice.`,
      { currency, voucher_currency: voucherCurrency ?? 'SEK' },
    )
  }
  const booked = receivableNetDebit(lines)
  if (booked <= 0) {
    return refuse(
      'INVOICE_REGISTER_VOUCHER_NOT_SALE',
      `Verifikat ${label} has no net debit on 151x: it is not the verifikat of a customer invoice (a payment, or a sale booked under kontantmetoden).`,
    )
  }
  if (!fx && Math.abs(booked - input.total) > ORE_TOLERANCE) {
    return refuse(
      'INVOICE_REGISTER_AMOUNT_MISMATCH',
      `Verifikat ${label} debits 151x by ${booked} but the invoice total is ${input.total} SEK.`,
      { booked_sek: booked, expected_sek: input.total },
    )
  }
  // The verifikat is the record for the invoice's own amount too: a total
  // the caller read elsewhere is checked against it, never taken over it.
  if (fx && Math.abs(fx.amount - input.total) > ORE_TOLERANCE) {
    return refuse(
      'INVOICE_REGISTER_AMOUNT_MISMATCH',
      `Verifikat ${label} debits 151x by ${fx.amount} ${currency} (${booked} SEK) but the invoice total is ${input.total} ${currency}.`,
      { currency, booked_in_currency: fx.amount, expected_in_currency: input.total, booked_sek: booked },
    )
  }
  const exchangeRate = fx ? rateGivingBack(input.total, booked, fx.statedRate) : null
  if (fx && exchangeRate === null) {
    return refuse(
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
      `Verifikat ${label} books ${booked} SEK for ${input.total} ${currency}, which gives no exchange rate an invoice can carry.`,
      { currency, booked_in_currency: fx.amount, booked_sek: booked },
    )
  }
  const warningsFor = (invoiceDate: string): BookedInvoiceWarning[] => voucherCorroborationWarnings({
    label,
    entryDate: voucher.entry_date,
    invoiceDate,
    texts: [voucher.description, ...lines.map((line) => line.line_description ?? null)],
    references: [input.invoice_number],
  })
  if (existing) return linkPlan(existing, customer.name ?? '', voucher, label, booked, warningsFor(existing.invoice_date))

  // The sale in kronor, as the verifikat books it: for SEK the caller's
  // total, which the check above holds to the booked amount.
  const totalSek = fx ? booked : input.total
  const unsupported = (reason: UnsupportedVoucherShape | 'rot_rut') => refuse(
    'INVOICE_REGISTER_VOUCHER_UNSUPPORTED',
    `Verifikat ${label} ${UNSUPPORTED_SHAPE_TEXT[reason]}: such an invoice cannot be registered this way yet. Leave it out of the register and tell the user its amount stays a difference between the kundreskontra and 1510.`,
    { reason },
  )
  // A ROT/RUT invoice's Skatteverket share needs deduction_total, which the
  // payout and reclaim flows key on; the registration does not model it.
  if (lines.some((line) => String(line.account_number) === ROT_RUT_RECEIVABLE_ACCOUNT && Math.abs(netCredit(line)) > ORE_TOLERANCE)) {
    return unsupported('rot_rut')
  }
  const implausibleVat = () => refuse(
    'INVOICE_REGISTER_VOUCHER_NOT_SALE',
    `Verifikat ${label} books output VAT that does not fit a sale of ${totalSek} SEK.`,
  )
  const derived = deriveInvoiceVatFromVoucher(lines, totalSek)
  if (!derived.ok) {
    if (derived.reason !== 'implausible_vat') return unsupported(derived.reason)
    return implausibleVat()
  }
  const vat = derived.vat
  // The invoice's VAT in its own currency: what the VAT lines carry in it
  // when they carry it, else the booked kronor at the invoice's rate. The
  // kronor VAT (ML 17 kap. 29 §) is the verifikat's either way.
  const vatAmount = exchangeRate === null || vat.vatAmount === 0
    ? vat.vatAmount
    : outputVatInCurrency(lines, currency) ?? roundOre(vat.vatAmount / exchangeRate)
  if (vatAmount < 0 || vatAmount >= input.total) return implausibleVat()

  const remaining = roundOre(input.remaining_amount)
  const status = remaining < input.total - ORE_TOLERANCE ? 'partially_paid' : 'sent'
  const paidAmount = roundOre(input.total - remaining)
  const warnings = warningsFor(input.invoice_date)
  // The daily reminder ladder follows only invoices sent from here
  // (lib/reminders/policy.ts): a registered one has no delivery history, so
  // with reminders on it is still never reminded by itself. Said where a
  // person could expect otherwise: owed, past due, a customer with an e-mail
  // address, and reminders actually on (product-wide and for the company,
  // crm#95).
  const today = options.today ?? todayIsoStockholm()
  if (
    (status === 'sent' || status === 'partially_paid') &&
    isPastDue(input.due_date, today) &&
    customer.email &&
    remindersActiveFor(settings?.send_invoice_reminders)
  ) {
    warnings.push({
      code: 'REGISTER_OVERDUE_NOT_REMINDED',
      message_sv: 'Fakturan har förfallit. En registrerad faktura får inga påminnelser av sig själv, eftersom den inte skickades härifrån: skicka en påminnelse från fakturan om kunden ska få en.',
      message_en: 'The invoice is past due. A registered invoice gets no reminders by itself, as it was not sent from here: send a reminder from the invoice if the customer should get one.',
    })
  }

  return {
    ok: true,
    plan: {
      customerName: customer.name ?? '',
      voucher: { journalEntryId: voucher.id, label, entryDate: voucher.entry_date, description: voucher.description },
      linksInvoiceId: null,
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      status,
      currency,
      exchangeRate,
      totalSek,
      subtotalSek: vat.subtotal,
      vatAmountSek: vat.vatAmount,
      total: input.total,
      subtotal: exchangeRate === null ? vat.subtotal : roundOre(input.total - vatAmount),
      vatAmount,
      vatRate: vat.vatRate,
      vatTreatment: vat.vatTreatment,
      momsRuta: vat.momsRuta,
      reverseChargeText: vat.reverseChargeText,
      paidAmount,
      remainingAmount: remaining,
      paidAsOf: paidAmount > 0 ? input.balance_as_of ?? null : null,
      warnings,
    },
  }
}

/**
 * The plan for linking a row the register already holds: its kronor must be
 * what the verifikat books on 151x (the migration linker's rule), and every
 * amount the approver sees is the row's own, since none of it is written.
 */
function linkPlan(
  row: LinkableRow,
  customerName: string,
  voucher: VoucherRow,
  label: string,
  booked: number,
  warnings: BookedInvoiceWarning[],
): { ok: true; plan: BookedInvoicePlan } | BookedInvoiceRefusal {
  const total = Number(row.total)
  const totalSek = roundOre(Number(row.total_sek ?? row.total))
  if (Math.abs(booked - totalSek) > ORE_TOLERANCE) {
    return refuse(
      'INVOICE_REGISTER_AMOUNT_MISMATCH',
      `Verifikat ${label} debits 151x by ${booked} SEK but invoice_id ${row.id} in the register is ${totalSek} SEK.`,
      { booked_sek: booked, expected_sek: totalSek, invoice_id: row.id },
    )
  }
  const currency = row.currency ?? 'SEK'
  const subtotal = Number(row.subtotal)
  const vatAmount = Number(row.vat_amount)
  return {
    ok: true,
    plan: {
      customerName,
      voucher: { journalEntryId: voucher.id, label, entryDate: voucher.entry_date, description: voucher.description },
      linksInvoiceId: row.id,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      status: row.status,
      currency,
      exchangeRate: row.exchange_rate == null ? null : Number(row.exchange_rate),
      totalSek,
      subtotalSek: Number(row.subtotal_sek ?? subtotal),
      vatAmountSek: Number(row.vat_amount_sek ?? vatAmount),
      total,
      subtotal,
      vatAmount,
      vatRate: Number(row.vat_rate ?? 0),
      // The column's default, for a row that never set it.
      vatTreatment: row.vat_treatment ?? 'standard_25',
      momsRuta: row.moms_ruta,
      reverseChargeText: row.reverse_charge_text,
      paidAmount: Number(row.paid_amount ?? 0),
      remainingAmount: Number(row.remaining_amount ?? total),
      paidAsOf: null,
      warnings,
    },
  }
}

/**
 * Register the invoice: the plan's rules once more, then one invoices row
 * and, for a partly paid invoice, the payment row that dates its paid part.
 * No journal entry or line is written.
 */
export async function registerBookedInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: RegisterBookedInvoiceInput,
  options: { today?: string } = {},
): Promise<{ ok: true; invoiceId: string; plan: BookedInvoicePlan } | BookedInvoiceRefusal> {
  const planned = await planBookedInvoiceRegistration(supabase, companyId, input, options)
  if (!planned.ok) return planned
  const { plan } = planned

  if (plan.linksInvoiceId) {
    // From null only: a row linked since the plan read it is left alone.
    const { data: linked, error: linkError } = await supabase
      .from('invoices')
      .update({ journal_entry_id: plan.voucher.journalEntryId })
      .eq('id', plan.linksInvoiceId)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .select('id')
    if (linkError) {
      if ((linkError as { code?: string }).code === '23505') {
        return refuse('INVOICE_REGISTER_VOUCHER_TAKEN', `Verifikat ${plan.voucher.label} already books another invoice.`)
      }
      throw dbError(linkError)
    }
    if (!linked || linked.length === 0) {
      return refuse(
        'INVOICE_REGISTER_NUMBER_TAKEN',
        `Invoice number ${input.invoice_number} got a verifikat since the registration was staged (invoice_id ${plan.linksInvoiceId}).`,
        { invoice_id: plan.linksInvoiceId },
      )
    }
    return { ok: true, invoiceId: plan.linksInvoiceId, plan }
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: input.customer_id,
      invoice_number: input.invoice_number,
      invoice_date: input.invoice_date,
      due_date: input.due_date,
      status: plan.status,
      document_type: 'invoice',
      currency: plan.currency,
      // Null for SEK, the columns' default; else dated the day the verifikat booked that rate.
      exchange_rate: plan.exchangeRate,
      exchange_rate_date: plan.exchangeRate === null ? null : plan.voucher.entryDate,
      subtotal: plan.subtotal,
      subtotal_sek: plan.subtotalSek,
      vat_amount: plan.vatAmount,
      vat_amount_sek: plan.vatAmountSek,
      total: plan.total,
      total_sek: plan.totalSek,
      vat_rate: plan.vatRate,
      vat_treatment: plan.vatTreatment,
      moms_ruta: plan.momsRuta,
      reverse_charge_text: plan.reverseChargeText,
      paid_amount: plan.paidAmount,
      remaining_amount: plan.remainingAmount,
      journal_entry_id: plan.voucher.journalEntryId,
    })
    .select('id')
    .single()

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      if (error.message.includes('idx_invoices_journal_entry_id_unique')) {
        return refuse('INVOICE_REGISTER_VOUCHER_TAKEN', `Verifikat ${plan.voucher.label} already books another invoice.`)
      }
      return refuse('INVOICE_REGISTER_NUMBER_TAKEN', `Invoice number ${input.invoice_number} is already in the register.`)
    }
    throw dbError(error)
  }
  const invoiceId = (data as { id: string }).id

  // The part paid before the registration, dated the reskontra's date and
  // tied to no verifikat: the payments are in the books already, wherever
  // the old system booked them.
  if (plan.paidAmount > 0 && plan.paidAsOf) {
    const recorded = await recordInvoicePaymentRow(supabase, {
      userId,
      companyId,
      invoice: { id: invoiceId, currency: plan.currency, exchange_rate: plan.exchangeRate, paid_amount: 0 },
      paymentDate: plan.paidAsOf,
      newPaidAmount: plan.paidAmount,
      journalEntryId: null,
      notes: `Betalt före registreringen enligt kundreskontran per ${plan.paidAsOf}`,
      // The old system's kundreskontra says it was paid; no pair was chosen here.
      linkBasis: { basis: 'import_carried_over' },
    })
    if (!recorded.ok) {
      // Inserted a moment ago and referenced by nothing yet: undo it, so a
      // retry is not refused as a number already in the register.
      const { error: undoError } = await supabase
        .from('invoices')
        .delete()
        .eq('id', invoiceId)
        .eq('company_id', companyId)
      if (undoError) {
        log.error('registration rollback failed: the invoice row may be stranded without its payment row', undoError, { companyId, invoiceId })
      }
      throw dbError({ message: recorded.error, code: recorded.code ?? null })
    }
  }
  return { ok: true, invoiceId, plan }
}
