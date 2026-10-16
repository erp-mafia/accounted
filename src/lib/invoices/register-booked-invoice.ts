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
 * No invoice_items are written, on purpose: invoice-register-coverage.ts
 * reads "linked to a verifikat, no lines" as an invoice registered from the
 * books, one open item of an older history, so registrations never move the
 * register's coverage boundary.
 *
 * SEK only: a foreign-currency invoice needs its own amount and the rate the
 * old system used, which the verifikat alone does not give.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import type { VatTreatment } from '@/types'
import { recordInvoicePaymentRow } from './invoice-payment-row'
import { seriesNumberOf } from './invoice-number-series'
import { REGISTER_BOOKED_INVOICE_MODE } from './register-booked-invoice-mode'
import {
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
 * How far the booked VAT may sit from its rate of the rest of the sale, in
 * kronor: the per-line öre rounding of a long invoice and an öresavrundning
 * on 3740 stay well inside it. Beyond it part of the sale carries no VAT (or
 * another rate's), which a header-only kreditfaktura would reverse as taxed.
 */
const VAT_OF_SUBTOTAL_TOLERANCE_SEK = 1

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
  total: registeredAmountSchema,
  /** The reskontra's own date: what the remaining balance is stated as of. */
  balance_as_of: saneIsoDateSchema.optional(),
  /** The invoice's currency per the reskontra; anything but SEK is refused. */
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
    const expectedVat = roundOre((subtotal * rate) / 100)
    if (roundOre(Math.abs(vatAmount - expectedVat)) > VAT_OF_SUBTOTAL_TOLERANCE_SEK) {
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
  code: 'REGISTER_VOUCHER_TEXT' | 'REGISTER_VOUCHER_DATE' | 'REGISTER_OVERDUE_REMINDERS'
  message_sv: string
  message_en: string
}

export interface BookedInvoicePlan {
  customerName: string
  voucher: { journalEntryId: string; label: string; entryDate: string; description: string | null }
  status: 'sent' | 'partially_paid'
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
      .select('id')
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
      .select('account_number, debit_amount, credit_amount, currency, line_description')
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
  if (input.currency && input.currency !== 'SEK') {
    return refuse(
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
      `The invoice is in ${input.currency}: only SEK invoices can be registered this way for now. Leave it out of the register.`,
      { currency: input.currency },
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
  const taken = ((numberRes.data ?? []) as { id: string }[])[0]
  if (taken) return numberTaken(taken.id)

  // Accounted issues invoice_prefix + next_invoice_number, padded to three
  // digits, and never skips a number that is taken. So an old number in that
  // series is one löpnummer with Accounted's spelling of it ("12" and "012"),
  // and one at or past the counter would be issued a second time later. The
  // counter is never moved here: only the user knows where the old series
  // ended, open items alone do not say.
  const inSeries = settings ? seriesNumberOf(input.invoice_number, settings.invoice_prefix) : null
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
  const currency = receivableForeignCurrency(lines)
  if (currency) {
    return refuse(
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
      `Verifikat ${label} books the receivable in ${currency}: only SEK invoices can be registered this way for now.`,
      { currency },
    )
  }
  const booked = receivableNetDebit(lines)
  if (booked <= 0) {
    return refuse(
      'INVOICE_REGISTER_VOUCHER_NOT_SALE',
      `Verifikat ${label} has no net debit on 151x: it is not the verifikat of a customer invoice (a payment, or a sale booked under kontantmetoden).`,
    )
  }
  if (Math.abs(booked - input.total) > ORE_TOLERANCE) {
    return refuse(
      'INVOICE_REGISTER_AMOUNT_MISMATCH',
      `Verifikat ${label} debits 151x by ${booked} but the invoice total is ${input.total} SEK.`,
      { booked_sek: booked, expected_sek: input.total },
    )
  }
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
  const derived = deriveInvoiceVatFromVoucher(lines, input.total)
  if (!derived.ok) {
    if (derived.reason !== 'implausible_vat') return unsupported(derived.reason)
    return refuse(
      'INVOICE_REGISTER_VOUCHER_NOT_SALE',
      `Verifikat ${label} books output VAT that does not fit a sale of ${input.total} SEK.`,
    )
  }
  const vat = derived.vat

  const remaining = roundOre(input.remaining_amount)
  const status = remaining < input.total - ORE_TOLERANCE ? 'partially_paid' : 'sent'
  const paidAmount = roundOre(input.total - remaining)
  const warnings: BookedInvoiceWarning[] = voucherCorroborationWarnings({
    label,
    entryDate: voucher.entry_date,
    invoiceDate: input.invoice_date,
    texts: [voucher.description, ...lines.map((line) => line.line_description ?? null)],
    references: [input.invoice_number],
  })
  // The reminder run writes to every unpaid 'sent' invoice past its due date
  // whose customer has an e-mail address (partially_paid is never reminded),
  // but only while sending is on, product-wide and for the company: the
  // company setting alone promises reminders that never go out (crm#95).
  const today = options.today ?? todayIsoStockholm()
  if (status === 'sent' && input.due_date < today && customer.email && remindersActiveFor(settings?.send_invoice_reminders)) {
    warnings.push({
      code: 'REGISTER_OVERDUE_REMINDERS',
      message_sv: 'Fakturan har förfallit och kunden har en e-postadress: Accounted skickar automatiska betalningspåminnelser för den. Stäng av påminnelser under Inställningar, Utskick om det gamla systemet sköter dem.',
      message_en: 'The invoice is past due and the customer has an e-mail address: Accounted will send it automatic payment reminders. Turn send_invoice_reminders off first (Inställningar, Utskick) if the old system handles reminders.',
    })
  }

  return {
    ok: true,
    plan: {
      customerName: customer.name ?? '',
      voucher: { journalEntryId: voucher.id, label, entryDate: voucher.entry_date, description: voucher.description },
      status,
      total: input.total,
      subtotal: vat.subtotal,
      vatAmount: vat.vatAmount,
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
      currency: 'SEK',
      subtotal: plan.subtotal,
      subtotal_sek: plan.subtotal,
      vat_amount: plan.vatAmount,
      vat_amount_sek: plan.vatAmount,
      total: plan.total,
      total_sek: plan.total,
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
    // The unique (company_id, invoice_number) index: the number was taken
    // between the plan's read and this insert.
    if ((error as { code?: string }).code === '23505') {
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
      invoice: { id: invoiceId, currency: 'SEK', exchange_rate: null, paid_amount: 0 },
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
