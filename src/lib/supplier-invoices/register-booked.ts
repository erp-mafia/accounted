/**
 * Register a supplier invoice that is already in the books (crm#1094).
 *
 * A company that moves to Accounted with an SIE file brings its verifikat but
 * not its leverantörsreskontra: SIE carries no open items, so 2440 holds a
 * balance no supplier invoice explains. Every door that creates a supplier
 * invoice (the inbox tool, the dashboard and v1 routes) posts its own
 * registration verifikat under faktureringsmetoden, which books the cost and
 * the ingående moms a second time. Only the provider migrations reach the end
 * state of an invoice in the reskontra linked to the SIE verifikat that booked
 * it (link-migrated-registration-vouchers.ts). This is that end state, one
 * invoice at a time, for an agent reading the old reskontra:
 *
 *  - the invoice keeps the supplier's number, and the ankomstnummer the old
 *    system gave it when the agent has one; that number must lie below
 *    next_arrival_number, where Accounted's own series starts, so Accounted
 *    never draws it and its series does not move. Without one the invoice
 *    takes the next number of that series. A supplier that prints the same
 *    number on every invoice (an autogiro or contract reference, crm#1039)
 *    gets the provider migration's rule (20261006184512): the same number on
 *    another invoice date is another invoice, registered without a number
 *    and with the reference as its payment_reference;
 *  - it links the verifikat that booked it (registration_journal_entry_id)
 *    after the corroboration the migration linker requires: posted, not
 *    already another supplier invoice's verifikat, and a net credit on 244x
 *    equal to the total;
 *  - nothing is written to the journal. The rows are the verifikat's own
 *    kontering, every line but the skuld on 244x netted per account and
 *    dimensions, the ingående moms as a row of its own without moms of its
 *    own: the shape the provider migration stores for Fortnox and Visma
 *    invoices, and the skuld's dimensions are the invoice's
 *    default_dimensions. A row that nets to a credit (an öresavrundning
 *    downwards, a discount) is a negative row. Omvänd betalningsskyldighet
 *    and import are rows too: the basis on 44xx/45xx against 4598, the
 *    buyer's own VAT on 26x4/26x5 against its deduction on 264x, with
 *    reverse_charge off so nothing self-assesses it a second time, and the
 *    header labelled by the supplier's moms alone (exempt when none). A
 *    kreditfaktura reverses its original from the rows
 *    (createSupplierCreditNoteEntry books each one on its other side and
 *    debits 2440 by their sum, under default_dimensions), so it returns
 *    every account, dimension and momsruta the verifikat booked, rutor
 *    20-24, 30-32, 48, 50 and 60-62 included; when the skuld's dimensions
 *    cannot be carried that way, the plan says so. Net and moms on the header
 *    are read from the same rows, the buyer's own VAT left out of the moms.
 *    The registration itself cannot be undone: a kreditfaktura is only for a
 *    credit note the supplier actually issued;
 *  - refused is VAT on 26xx other than ingående moms and the buyer's own
 *    VAT (2650, utgående moms on a sale): not the verifikat of a purchase;
 *  - a partly paid invoice carries paid_amount = total - remaining, and the
 *    part already paid is one supplier_invoice_payments row dated the
 *    reskontra's date (balance_as_of), without a verifikat: the as-of
 *    reskontra reads payment rows as authoritative, so without it a later
 *    payment would reopen that part at every historical date;
 *  - faktureringsmetoden only. Under kontantmetoden an open invoice's cost
 *    and moms are booked when it is paid, and the year-end cut-off books
 *    every open invoice from its rows, so a registration would book them
 *    a second time.
 *
 * SEK only: a foreign-currency invoice needs its own amount and the rate the
 * old system used, which the verifikat alone does not give.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dimensionsBagKey,
  normalizeLineDimensions,
  type LineDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
import { dbError } from '@/lib/errors/db-error'
import { eventBus } from '@/lib/events'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { REGISTER_BOOKED_INVOICE_MODE } from '@/lib/invoices/register-booked-invoice-mode'
import { recordSupplierInvoicePaymentRow } from '@/lib/invoices/supplier-invoice-payment-row'
import {
  refineRegistrationDatesAndAmounts,
  registeredAmountSchema,
  registrationVoucherLabel,
  reskontraCurrencySchema,
  voucherCorroborationWarnings,
  type VoucherCorroborationWarning,
} from '@/lib/invoices/register-booked-rules'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import type { SupplierInvoice, VatTreatment } from '@/types'

const log = createLogger('register-booked-supplier-invoice')

export type RegisterBookedSupplierInvoiceErrorCode =
  | 'SUPPLIER_NOT_FOUND'
  | 'SI_REGISTER_CASH_METHOD'
  | 'SI_REGISTER_FOREIGN_CURRENCY'
  | 'SI_REGISTER_NUMBER_TAKEN'
  | 'SI_REGISTER_NUMBER_REUSED'
  | 'SI_REGISTER_ARRIVAL_NUMBER_TAKEN'
  | 'SI_REGISTER_ARRIVAL_NUMBER_IN_SERIES'
  | 'SI_REGISTER_VOUCHER_NOT_FOUND'
  | 'SI_REGISTER_VOUCHER_NOT_POSTED'
  | 'SI_REGISTER_OPENING_BALANCE'
  | 'SI_REGISTER_VOUCHER_TAKEN'
  | 'SI_REGISTER_VOUCHER_NOT_PURCHASE'
  | 'SI_REGISTER_AMOUNT_MISMATCH'
  | 'SI_REGISTER_VOUCHER_UNSUPPORTED'

/** BAS 2440-2449 Leverantörsskulder: the verifikat of a supplier invoice credits it. */
const PAYABLE_ACCOUNT_PREFIX = '244'

/** The skuld account every payment and kreditfaktura in Accounted clears. */
const PAYABLE_ACCOUNT = '2440'

/** BAS 264x Ingående moms. */
const INPUT_VAT_PREFIX = '264'

/** BAS 26xx: every VAT account. */
const VAT_PREFIX = '26'

/**
 * The momsdeklaration rutor of the buyer's own output VAT on a purchase:
 * omvänd betalningsskyldighet (30-32, 2614/2624/2634) and import (60-62,
 * 2615/2625/2635), read from the declaration's own map (ACCOUNT_RUTA) so the
 * two cannot drift.
 */
const SELF_ASSESSED_OUTPUT_RUTOR = new Set(['ruta30', 'ruta31', 'ruta32', 'ruta60', 'ruta61', 'ruta62'])

/** journal_entries.source_type of entries that never book a supplier invoice. */
const NOT_A_PURCHASE_SOURCE_TYPES = new Set(['year_end', 'storno'])

/** supplier_invoices.arrival_number is an int4. */
const MAX_ARRIVAL_NUMBER = 2147483647

const commonShape = {
  supplier_id: z.string().uuid(),
  /** The supplier's number as printed on the invoice, kept as is. */
  supplier_invoice_number: z.string().trim().min(1).max(100),
  /** The ankomstnummer the old system gave the invoice; omitted, the next one in Accounted's series. */
  arrival_number: z.number().int().positive().max(MAX_ARRIVAL_NUMBER).optional(),
  invoice_date: saneIsoDateSchema,
  due_date: saneIsoDateSchema,
  journal_entry_id: z.string().uuid(),
  total: registeredAmountSchema,
  /** The reskontra's own date: what the remaining balance is stated as of. */
  balance_as_of: saneIsoDateSchema.optional(),
  /** The invoice's currency per the reskontra; anything but SEK is refused. */
  currency: reskontraCurrencySchema.optional(),
  /** The OCR number (or other reference) the supplier is paid with. */
  payment_reference: z.string().trim().min(1).max(100).optional(),
}

/** The tool's arguments: remaining_amount defaults to the total (unpaid). */
export const RegisterBookedSupplierInvoiceInputSchema = z
  .object({ ...commonShape, remaining_amount: registeredAmountSchema.optional() })
  .strict()
  .superRefine(refineRegistrationDatesAndAmounts)

/**
 * The staged params: the input with remaining_amount resolved, under the
 * create_supplier_invoice_from_inbox pending type.
 */
export const RegisterBookedSupplierInvoiceParamsSchema = z
  .object({ mode: z.literal(REGISTER_BOOKED_INVOICE_MODE), ...commonShape, remaining_amount: registeredAmountSchema })
  .strict()
  .superRefine(refineRegistrationDatesAndAmounts)

export type RegisterBookedSupplierInvoiceInput = z.infer<typeof RegisterBookedSupplierInvoiceParamsSchema>

/** The staged params for a validated input. */
export function toRegisterBookedSupplierInvoiceParams(
  input: z.infer<typeof RegisterBookedSupplierInvoiceInputSchema>,
): RegisterBookedSupplierInvoiceInput {
  return { mode: REGISTER_BOOKED_INVOICE_MODE, ...input, remaining_amount: input.remaining_amount ?? input.total }
}

export interface BookedSupplierInvoiceVoucherLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  currency?: string | null
  line_description?: string | null
  dimensions?: Record<string, string> | null
}

/** Net debit of a verifikat line, to the öre. */
const netDebit = (line: BookedSupplierInvoiceVoucherLine) =>
  roundOre((Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0))

const isPayable = (account: string) => account.startsWith(PAYABLE_ACCOUNT_PREFIX)

/** Net credit on Leverantörsskulder (244x): what the verifikat says the company owes the supplier. */
export function payableNetCredit(lines: readonly BookedSupplierInvoiceVoucherLine[]): number {
  let net = 0
  for (const line of lines) {
    if (!isPayable(String(line.account_number))) continue
    net = roundOre(net - netDebit(line))
  }
  return net
}

/** The first non-SEK currency on a 244x line, or null when the skuld is booked in kronor. */
export function payableForeignCurrency(lines: readonly BookedSupplierInvoiceVoucherLine[]): string | null {
  for (const line of lines) {
    if (!isPayable(String(line.account_number))) continue
    const currency = line.currency?.trim().toUpperCase()
    if (currency && currency !== 'SEK') return currency
  }
  return null
}

/** One row of a registered invoice: a verifikat account (with its dimensions) other than the skuld, netted. */
export interface BookedSupplierInvoiceRow {
  account_number: string
  dimensions: LineDimensions
  /** The net debit: below zero for a row that nets to a credit (a discount, the output side of a reverse charge). */
  amount: number
  /** The first text the verifikat gives the account's lines, or null. */
  description: string | null
}

/** A purchase the registration cannot hold (see the module header). */
export type UnsupportedSupplierVoucherShape = 'other_vat'

export type SupplierInvoiceRowsFromVoucher =
  | {
      ok: true
      rows: BookedSupplierInvoiceRow[]
      subtotal: number
      vatAmount: number
    }
  | { ok: false; reason: UnsupportedSupplierVoucherShape; account: string }

function isSelfAssessedOutputVat(account: string): boolean {
  return Object.hasOwn(ACCOUNT_RUTA, account) && SELF_ASSESSED_OUTPUT_RUTOR.has(ACCOUNT_RUTA[account].box)
}

/**
 * The invoice's rows from the verifikat that booked it: every line but the
 * skuld on 244x, netted per account and dimensions, in the verifikat's order,
 * a row that nets to a credit included. Moms is the ingående moms on 264x
 * beyond the buyer's own VAT, which the verifikat declares on 26x4/26x5 and
 * deducts on 264x: the supplier charged none of it. It is never below zero,
 * since a partly deductible self-assessment deducts less than it declares.
 * Net is the rest of the rows. Refused: VAT on a 26xx account other than
 * ingående moms and the buyer's own.
 */
export function supplierInvoiceRowsFromVoucher(
  lines: readonly BookedSupplierInvoiceVoucherLine[],
): SupplierInvoiceRowsFromVoucher {
  const groups = new Map<string, BookedSupplierInvoiceRow>()
  for (const line of lines) {
    const account = String(line.account_number)
    if (isPayable(account)) continue
    const dimensions = normalizeLineDimensions({ dimensions: line.dimensions ?? null })
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const row: BookedSupplierInvoiceRow = groups.get(key) ?? { account_number: account, dimensions, amount: 0, description: null }
    row.amount = roundOre(row.amount + netDebit(line))
    row.description ??= line.line_description?.trim() || null
    groups.set(key, row)
  }
  const rows = [...groups.values()].filter((row) => Math.abs(row.amount) > ORE_TOLERANCE)

  const otherVat = rows.find((row) =>
    row.account_number.startsWith(VAT_PREFIX) &&
    !row.account_number.startsWith(INPUT_VAT_PREFIX) &&
    !isSelfAssessedOutputVat(row.account_number))
  if (otherVat) return { ok: false, reason: 'other_vat', account: otherVat.account_number }

  const sumOf = (selected: BookedSupplierInvoiceRow[]) => roundOre(selected.reduce((sum, row) => sum + row.amount, 0))
  const inputVat = sumOf(rows.filter((row) => row.account_number.startsWith(INPUT_VAT_PREFIX)))
  // Declared on the credit side, so its rows net below zero.
  const ownVat = -sumOf(rows.filter((row) => isSelfAssessedOutputVat(row.account_number)))
  const vatAmount = ownVat > ORE_TOLERANCE ? Math.max(0, roundOre(inputVat - ownVat)) : inputVat
  const subtotal = roundOre(sumOf(rows) - vatAmount)
  return { ok: true, rows, subtotal, vatAmount }
}

/**
 * The skuld's dimensions as the invoice's default_dimensions, or null when
 * the invoice cannot carry them. A payment or kreditfaktura of a supplier
 * invoice debits 2440 under default_dimensions, and the kreditfaktura merges
 * that bag under every row's own, the row's value winning per key
 * (groupExpenseBuckets). The bag therefore reverses the verifikat cell by
 * cell only when the 244x lines carry one bag and every row already has each
 * of its keys: a key a row lacks would move that row to a cell the verifikat
 * never booked.
 */
export function payableDimensions(
  lines: readonly BookedSupplierInvoiceVoucherLine[],
  rows: readonly BookedSupplierInvoiceRow[],
): LineDimensions | null {
  const bags = new Map<string, { dimensions: LineDimensions; net: number }>()
  for (const line of lines) {
    if (!isPayable(String(line.account_number))) continue
    const dimensions = normalizeLineDimensions({ dimensions: line.dimensions ?? null })
    const key = dimensionsBagKey(dimensions)
    const bag = bags.get(key) ?? { dimensions, net: 0 }
    bag.net = roundOre(bag.net + netDebit(line))
    bags.set(key, bag)
  }
  const booked = [...bags.values()].filter((bag) => Math.abs(bag.net) > ORE_TOLERANCE)
  if (booked.length === 0) return {}
  if (booked.length > 1) return null
  const keys = Object.keys(booked[0].dimensions)
  return rows.every((row) => keys.every((key) => Object.hasOwn(row.dimensions, key))) ? booked[0].dimensions : null
}

const TREATMENT_BY_RATE: ReadonlyArray<readonly [number, VatTreatment]> = [
  [25, 'standard_25'],
  [12, 'reduced_12'],
  [6, 'reduced_6'],
]

/**
 * The header's momsbehandling, a label: the rows carry the moms on 264x and
 * the buyer's own VAT, so nothing books from it. The rate the moms is of the
 * net (within half a percentage point, as the provider migration reads it),
 * standard_25 for moms at no one rate, and exempt when the supplier charged
 * none. That includes omvänd betalningsskyldighet and import: the label
 * reverse_charge belongs to invoices with reverse_charge on, which Accounted
 * self-assesses, and the two never disagree (create.ts).
 */
function treatmentOf(subtotal: number, vatAmount: number): VatTreatment {
  if (vatAmount <= ORE_TOLERANCE) return 'exempt'
  const percent = subtotal > 0 ? (vatAmount / subtotal) * 100 : Number.NaN
  return TREATMENT_BY_RATE.find(([rate]) => Math.abs(percent - rate) < 0.5)?.[1] ?? 'standard_25'
}

const UNSUPPORTED_SHAPE_TEXT: Record<UnsupportedSupplierVoucherShape, (account: string) => string> = {
  other_vat: (account) => `books ${account}, VAT other than ingående moms (264x) and the buyer's own VAT on a reverse charge or import`,
}

export interface BookedSupplierInvoiceWarning {
  code:
    | VoucherCorroborationWarning['code']
    | 'REGISTER_NUMBER_AS_PAYMENT_REFERENCE'
    | 'REGISTER_PAYABLE_ACCOUNT'
    | 'REGISTER_PAYABLE_DIMENSIONS'
  message_sv: string
  message_en: string
}

export interface BookedSupplierInvoicePlan {
  supplierName: string
  /** The supplier's number as stored: null when the supplier reuses it, which makes it the payment reference. */
  supplierInvoiceNumber: string | null
  /** The payment reference as stored: the agent's, or the reused number. */
  paymentReference: string | null
  voucher: { journalEntryId: string; label: string; entryDate: string; description: string | null }
  /** The ankomstnummer the agent gave, or null: the next one in Accounted's series is drawn at registration. */
  arrivalNumber: number | null
  status: 'registered' | 'partially_paid'
  total: number
  subtotal: number
  vatAmount: number
  vatTreatment: VatTreatment
  /** The invoice's rows, each with the text it is stored under. */
  rows: Array<BookedSupplierInvoiceRow & { description: string }>
  /** The skuld's dimensions (payableDimensions); {} when the invoice cannot carry them. */
  defaultDimensions: LineDimensions
  /** The verifikat's lines as the approver checks them. */
  voucherLines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
  paidAmount: number
  remainingAmount: number
  /** The reskontra date the part already paid is dated to; null when nothing is paid. */
  paidAsOf: string | null
  warnings: BookedSupplierInvoiceWarning[]
}

export interface BookedSupplierInvoiceRefusal {
  ok: false
  code: RegisterBookedSupplierInvoiceErrorCode
  /** English, naming what the registry sentence cannot (which verifikat, which amounts). */
  message: string
  details?: Record<string, unknown>
}

const refuse = (
  code: RegisterBookedSupplierInvoiceErrorCode,
  message: string,
  details?: Record<string, unknown>,
): BookedSupplierInvoiceRefusal => ({ ok: false, code, message, ...(details ? { details } : {}) })

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
 * preview and the commit runs it again, so a verifikat reversed or claimed
 * between staging and approval is refused at approval. A supplier invoice
 * number taken in between by an invoice of another date is not refused: the
 * re-run plan stores this one as a reused number, with the number as its
 * payment reference, even when the staged card showed it kept.
 */
export async function planBookedSupplierInvoiceRegistration(
  supabase: SupabaseClient,
  companyId: string,
  input: RegisterBookedSupplierInvoiceInput,
): Promise<{ ok: true; plan: BookedSupplierInvoicePlan } | BookedSupplierInvoiceRefusal> {
  const [supplierRes, settingsRes, numberRes, referenceRes, arrivalRes, voucherRes, linesRes, holderRes] = await Promise.all([
    supabase
      .from('suppliers')
      .select('id, name, archived_at')
      .eq('id', input.supplier_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('company_settings')
      .select('accounting_method, next_arrival_number')
      .eq('company_id', companyId)
      .maybeSingle(),
    // idx_supplier_invoices_company_supplier_number: unique per supplier
    // among the invoices that are not credited or reversed.
    supabase
      .from('supplier_invoices')
      .select('id, invoice_date')
      .eq('company_id', companyId)
      .eq('supplier_id', input.supplier_id)
      .eq('supplier_invoice_number', input.supplier_invoice_number)
      .not('status', 'in', '(credited,reversed)')
      .limit(1),
    // The same invoice stored by the reused-number rule below: no number,
    // the reference as its payment_reference, the same invoice date.
    supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('supplier_id', input.supplier_id)
      .is('supplier_invoice_number', null)
      .eq('payment_reference', input.supplier_invoice_number)
      .eq('invoice_date', input.invoice_date)
      .not('status', 'in', '(credited,reversed)')
      .limit(1),
    input.arrival_number === undefined
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('supplier_invoices')
          .select('id')
          .eq('company_id', companyId)
          .eq('arrival_number', input.arrival_number)
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
      .select('account_number, debit_amount, credit_amount, currency, line_description, dimensions')
      .eq('journal_entry_id', input.journal_entry_id)
      .order('sort_order', { ascending: true }),
    supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, arrival_number')
      .eq('company_id', companyId)
      .eq('registration_journal_entry_id', input.journal_entry_id)
      .limit(1),
  ])
  for (const res of [supplierRes, settingsRes, numberRes, referenceRes, arrivalRes, voucherRes, linesRes, holderRes]) {
    if (res.error) throw dbError(res.error)
  }

  const settings = settingsRes.data as { accounting_method: string | null; next_arrival_number: number | null } | null
  if (settings?.accounting_method === 'cash') {
    return refuse(
      'SI_REGISTER_CASH_METHOD',
      'The company uses kontantmetoden: an open supplier invoice\'s cost and VAT are booked when it is paid, and the year-end cut-off books open invoices from their rows, so it cannot be linked to a verifikat. Registering open supplier invoices is supported under faktureringsmetoden only, for now.',
    )
  }
  if (input.currency && input.currency !== 'SEK') {
    return refuse(
      'SI_REGISTER_FOREIGN_CURRENCY',
      `The invoice is in ${input.currency}: only SEK invoices can be registered this way for now. Leave it out of the register.`,
      { currency: input.currency },
    )
  }

  const supplier = supplierRes.data as { id: string; name: string | null; archived_at: string | null } | null
  if (!supplier || supplier.archived_at) {
    return refuse(
      'SUPPLIER_NOT_FOUND',
      supplier
        ? `Supplier ${input.supplier_id} is archived: an archived supplier takes no new invoices. Restore it first.`
        : `Supplier not found: no supplier with id ${input.supplier_id} in this company.`,
    )
  }

  // Some suppliers print the same number on every invoice (an autogiro or
  // contract reference, crm#1039). As commit_provider_migration_records reads
  // it (20261006184512), the same number on another invoice date is another
  // invoice: it registers without a number, the reference kept as its
  // payment_reference. The same number and date is the same invoice, also
  // against one stored that way. An invoice that carries a payment reference
  // of its own cannot keep both.
  const numberHolder = ((numberRes.data ?? []) as { id: string; invoice_date: string }[])[0]
  const storedAsReference = ((referenceRes.data ?? []) as { id: string }[])[0]
  const sameInvoice = numberHolder?.invoice_date === input.invoice_date ? numberHolder : storedAsReference
  if (sameInvoice) {
    return refuse(
      'SI_REGISTER_NUMBER_TAKEN',
      `Supplier invoice number ${input.supplier_invoice_number} of this supplier, dated ${input.invoice_date}, is already in the register (supplier_invoice_id ${sameInvoice.id}).`,
      { supplier_invoice_id: sameInvoice.id },
    )
  }
  if (numberHolder && input.payment_reference && input.payment_reference !== input.supplier_invoice_number) {
    return refuse(
      'SI_REGISTER_NUMBER_REUSED',
      `Supplier invoice number ${input.supplier_invoice_number} is already on this supplier's invoice of ${numberHolder.invoice_date} (supplier_invoice_id ${numberHolder.id}), so this one, dated ${input.invoice_date}, would keep the number as its payment reference, but it has its own (${input.payment_reference}) and cannot keep both. Leave it out of the register and tell the user its amount stays a difference between the leverantörsreskontra and 2440.`,
      { supplier_invoice_id: numberHolder.id, invoice_date: numberHolder.invoice_date },
    )
  }

  // Accounted draws ankomstnummer from get_next_arrival_number: the largest
  // number in use plus one, never below next_arrival_number. A number below
  // that setting is never drawn, so an old one kept there neither meets a
  // number Accounted issues nor moves the series. One at or past it would sit
  // in Accounted's own series, which would continue after it; only the user
  // knows where the old series ended, so the setting is never moved here.
  const nextArrivalNumber = Number(settings?.next_arrival_number ?? 1)
  if (input.arrival_number !== undefined) {
    const arrivalHolder = ((arrivalRes.data ?? []) as { id: string }[])[0]
    if (arrivalHolder) {
      return refuse(
        'SI_REGISTER_ARRIVAL_NUMBER_TAKEN',
        `Ankomstnummer ${input.arrival_number} is already taken (supplier_invoice_id ${arrivalHolder.id}). Leave arrival_number out to give the invoice the next number in Accounted's series.`,
        { arrival_number: input.arrival_number, supplier_invoice_id: arrivalHolder.id },
      )
    }
    if (input.arrival_number >= nextArrivalNumber) {
      return refuse(
        'SI_REGISTER_ARRIVAL_NUMBER_IN_SERIES',
        `Ankomstnummer ${input.arrival_number} is not below next_arrival_number (${nextArrivalNumber}), where Accounted's own series starts: kept there it would sit in that series, which would continue after it. Set next_arrival_number past the old series' last number with gnubok_update_company_settings, then retry, or leave arrival_number out.`,
        { arrival_number: input.arrival_number, next_arrival_number: nextArrivalNumber },
      )
    }
  }

  const voucher = voucherRes.data as VoucherRow | null
  if (!voucher) {
    return refuse('SI_REGISTER_VOUCHER_NOT_FOUND', `Journal entry not found: no verifikat with id ${input.journal_entry_id} in this company.`)
  }
  const label = registrationVoucherLabel(voucher)
  if (voucher.status !== 'posted') {
    return refuse(
      'SI_REGISTER_VOUCHER_NOT_POSTED',
      `Verifikat ${label} is ${voucher.status}, not posted: a supplier invoice can only be registered against a posted verifikat.`,
      { status: voucher.status },
    )
  }
  // SIE carries an invoice from before the first imported year only inside
  // that year's opening balance: one entry with every skuld summed on 2440.
  if (voucher.source_type === 'opening_balance') {
    return refuse(
      'SI_REGISTER_OPENING_BALANCE',
      `Verifikat ${label} is an opening balance (ingående balans), not the verifikat that booked supplier invoice ${input.supplier_invoice_number}. Import the SIE file of the year the invoice was booked in (oldest year first), then register the invoice against that year's verifikat.`,
    )
  }
  if (voucher.source_type && NOT_A_PURCHASE_SOURCE_TYPES.has(voucher.source_type)) {
    return refuse(
      'SI_REGISTER_VOUCHER_NOT_PURCHASE',
      `Verifikat ${label} is a ${voucher.source_type === 'storno' ? 'storno' : 'year-end'} entry, not the verifikat of a supplier invoice.`,
      { source_type: voucher.source_type },
    )
  }

  const holder = ((holderRes.data ?? []) as { id: string; supplier_invoice_number: string | null; arrival_number: number | null }[])[0]
  if (holder) {
    return refuse(
      'SI_REGISTER_VOUCHER_TAKEN',
      `Verifikat ${label} already books supplier invoice ${holder.supplier_invoice_number ?? `ankomstnummer ${holder.arrival_number}`} (supplier_invoice_id ${holder.id}).`,
      { supplier_invoice_id: holder.id },
    )
  }

  const lines = (linesRes.data ?? []) as BookedSupplierInvoiceVoucherLine[]
  const currency = payableForeignCurrency(lines)
  if (currency) {
    return refuse(
      'SI_REGISTER_FOREIGN_CURRENCY',
      `Verifikat ${label} books the skuld in ${currency}: only SEK invoices can be registered this way for now.`,
      { currency },
    )
  }
  const booked = payableNetCredit(lines)
  if (booked <= 0) {
    return refuse(
      'SI_REGISTER_VOUCHER_NOT_PURCHASE',
      `Verifikat ${label} has no net credit on 244x: it is not the verifikat of a supplier invoice (a payment, a credit note, or a purchase booked under kontantmetoden).`,
    )
  }
  if (Math.abs(booked - input.total) > ORE_TOLERANCE) {
    return refuse(
      'SI_REGISTER_AMOUNT_MISMATCH',
      `Verifikat ${label} credits 244x by ${booked} but the invoice total is ${input.total} SEK.`,
      { booked_sek: booked, expected_sek: input.total },
    )
  }

  const shape = supplierInvoiceRowsFromVoucher(lines)
  if (!shape.ok) {
    return refuse(
      'SI_REGISTER_VOUCHER_UNSUPPORTED',
      `Verifikat ${label} ${UNSUPPORTED_SHAPE_TEXT[shape.reason](shape.account)}: such an invoice cannot be registered this way yet. Leave it out of the register and tell the user its amount stays a difference between the leverantörsreskontra and 2440.`,
      { reason: shape.reason, account: shape.account },
    )
  }
  // A posted verifikat balances (check_journal_entry_balance), so the rows
  // sum to the skuld checked above: what a kreditfaktura debits 2440 by.

  const remaining = roundOre(input.remaining_amount)
  const status = remaining < input.total - ORE_TOLERANCE ? 'partially_paid' : 'registered'
  const paidAmount = roundOre(input.total - remaining)

  const warnings: BookedSupplierInvoiceWarning[] = voucherCorroborationWarnings({
    label,
    entryDate: voucher.entry_date,
    invoiceDate: input.invoice_date,
    texts: [voucher.description, ...lines.map((line) => line.line_description ?? null)],
    references: [input.supplier_invoice_number, input.arrival_number],
  })
  if (numberHolder) {
    warnings.push({
      code: 'REGISTER_NUMBER_AS_PAYMENT_REFERENCE',
      message_sv: `Leverantören har redan en faktura med nummer ${input.supplier_invoice_number}, daterad ${numberHolder.invoice_date}: ett nummer som leverantören återanvänder, till exempel ett avtals- eller autogironummer. Fakturan registreras därför utan nummer, med ${input.supplier_invoice_number} som betalningsreferens.`,
      message_en: `The supplier already has an invoice numbered ${input.supplier_invoice_number}, dated ${numberHolder.invoice_date}: a number the supplier reuses, such as a contract or autogiro reference. The invoice is therefore registered without a number, with ${input.supplier_invoice_number} as its payment reference.`,
    })
  }
  // Payments and kreditfakturor in Accounted always clear 2440, and the
  // leverantörsreskontra is reconciled against 2440.
  const otherPayables = [
    ...new Set(
      lines
        .filter((line) => isPayable(String(line.account_number)) && String(line.account_number) !== PAYABLE_ACCOUNT)
        .filter((line) => Math.abs(netDebit(line)) > ORE_TOLERANCE)
        .map((line) => String(line.account_number)),
    ),
  ].sort()
  if (otherPayables.length > 0) {
    warnings.push({
      code: 'REGISTER_PAYABLE_ACCOUNT',
      message_sv: `Verifikation ${label} bokför leverantörsskulden på ${otherPayables.join(', ')}, men betalningar och kreditfakturor i Accounted bokförs mot 2440: saldot står kvar tills det förs över till 2440.`,
      message_en: `Verifikat ${label} books the skuld on ${otherPayables.join(', ')}, but payments and kreditfakturor in Accounted clear 2440: that balance stays until it is moved to 2440.`,
    })
  }
  const skuldDimensions = payableDimensions(lines, shape.rows)
  if (skuldDimensions === null) {
    warnings.push({
      code: 'REGISTER_PAYABLE_DIMENSIONS',
      message_sv: `Verifikation ${label} bokför leverantörsskulden på dimensioner som fakturan inte kan föra vidare: betalningar och kreditfakturor i Accounted bokför 2440 utan dem, så saldot på 2440 per dimension står kvar tills det omförs.`,
      message_en: `Verifikat ${label} books the skuld under dimensions the invoice cannot carry: payments and kreditfakturor in Accounted debit 2440 without them, so the 2440 balance per dimension stays until it is moved.`,
    })
  }

  const fallbackDescription = voucher.description?.trim() || `Verifikation ${label}`
  return {
    ok: true,
    plan: {
      supplierName: supplier.name ?? '',
      supplierInvoiceNumber: numberHolder ? null : input.supplier_invoice_number,
      paymentReference: numberHolder ? input.supplier_invoice_number : input.payment_reference ?? null,
      voucher: { journalEntryId: voucher.id, label, entryDate: voucher.entry_date, description: voucher.description },
      arrivalNumber: input.arrival_number ?? null,
      status,
      total: input.total,
      subtotal: shape.subtotal,
      vatAmount: shape.vatAmount,
      vatTreatment: treatmentOf(shape.subtotal, shape.vatAmount),
      rows: shape.rows.map((row) => ({ ...row, description: row.description ?? fallbackDescription })),
      defaultDimensions: skuldDimensions ?? {},
      voucherLines: lines.map((line) => ({
        account_number: String(line.account_number),
        debit_amount: roundOre(Number(line.debit_amount) || 0),
        credit_amount: roundOre(Number(line.credit_amount) || 0),
      })),
      paidAmount,
      remainingAmount: remaining,
      paidAsOf: paidAmount > 0 ? input.balance_as_of ?? null : null,
      warnings,
    },
  }
}

/**
 * Register the invoice: the plan's rules once more, then one supplier_invoices
 * row with the verifikat's rows and, for a partly paid invoice, the payment
 * row that dates its paid part. No journal entry or line is written.
 */
export async function registerBookedSupplierInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: RegisterBookedSupplierInvoiceInput,
): Promise<
  | { ok: true; supplierInvoiceId: string; arrivalNumber: number; plan: BookedSupplierInvoicePlan }
  | BookedSupplierInvoiceRefusal
> {
  const planned = await planBookedSupplierInvoiceRegistration(supabase, companyId, input)
  if (!planned.ok) return planned
  const { plan } = planned

  let arrivalNumber = plan.arrivalNumber
  if (arrivalNumber === null) {
    const { data: next, error: nextError } = await supabase.rpc('get_next_arrival_number', { p_company_id: companyId })
    if (nextError) throw dbError(nextError)
    if (next == null) throw new Error('get_next_arrival_number returned no number')
    arrivalNumber = Number(next)
  }

  const { data, error } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_id: input.supplier_id,
      arrival_number: arrivalNumber,
      supplier_invoice_number: plan.supplierInvoiceNumber,
      invoice_date: input.invoice_date,
      due_date: input.due_date,
      // When it arrived is not in the reskontra; the invoice date stands in,
      // as in the provider migration.
      received_date: input.invoice_date,
      status: plan.status,
      currency: 'SEK',
      exchange_rate: null,
      exchange_rate_date: null,
      vat_treatment: plan.vatTreatment,
      reverse_charge: false,
      payment_reference: plan.paymentReference,
      // The skuld's dimensions: a payment or kreditfaktura debits 2440 in the
      // cell the verifikat credited.
      default_dimensions: plan.defaultDimensions,
      subtotal: plan.subtotal,
      subtotal_sek: plan.subtotal,
      vat_amount: plan.vatAmount,
      vat_amount_sek: plan.vatAmount,
      total: plan.total,
      total_sek: plan.total,
      paid_amount: plan.paidAmount,
      remaining_amount: plan.remainingAmount,
      registration_journal_entry_id: plan.voucher.journalEntryId,
    })
    .select()
    .single()

  if (error) {
    // The unique indexes: a number taken between the plan's read and this insert.
    const pgError = error as { code?: string; message?: string }
    if (pgError.code === '23505' && (pgError.message ?? '').includes('idx_supplier_invoices_company_supplier_number')) {
      return refuse('SI_REGISTER_NUMBER_TAKEN', `Supplier invoice number ${input.supplier_invoice_number} of this supplier is already in the register.`)
    }
    if (pgError.code === '23505' && input.arrival_number !== undefined && (pgError.message ?? '').includes('idx_supplier_invoices_company_arrival_number')) {
      return refuse('SI_REGISTER_ARRIVAL_NUMBER_TAKEN', `Ankomstnummer ${input.arrival_number} is already taken.`, { arrival_number: input.arrival_number })
    }
    throw dbError(error)
  }
  const registered = data as SupplierInvoice
  const supplierInvoiceId = registered.id

  // One insert per row, each a literal the schema guard can check
  // (tests/schema/no-phantom-columns): a supplier invoice has a few rows.
  for (const [index, row] of plan.rows.entries()) {
    const { error: rowError } = await supabase.from('supplier_invoice_items').insert({
      supplier_invoice_id: supplierInvoiceId,
      sort_order: index,
      description: row.description,
      quantity: 1,
      unit: 'st',
      unit_price: row.amount,
      line_total: row.amount,
      account_number: row.account_number,
      // The moms is a row of its own on 264x: no row carries moms of its own.
      vat_rate: 0,
      vat_amount: 0,
      dimensions: row.dimensions,
    })
    if (rowError) {
      await undoRegistration(supabase, companyId, supplierInvoiceId)
      throw dbError(rowError)
    }
  }

  // The part paid before the registration, dated the reskontra's date and
  // tied to no verifikat: the payments are in the books already, wherever
  // the old system booked them.
  if (plan.paidAmount > 0 && plan.paidAsOf) {
    const recorded = await recordSupplierInvoicePaymentRow(supabase, {
      userId,
      companyId,
      invoice: { id: supplierInvoiceId, currency: 'SEK', paid_amount: 0 },
      paymentDate: plan.paidAsOf,
      newPaidAmount: plan.paidAmount,
      journalEntryId: null,
      notes: `Betalt före registreringen enligt leverantörsreskontran per ${plan.paidAsOf}`,
      // The old system's leverantörsreskontra says it was paid; no pair was chosen here.
      linkBasis: { basis: 'import_carried_over' },
    })
    if (!recorded.ok) {
      await undoRegistration(supabase, companyId, supplierInvoiceId)
      throw dbError({ message: recorded.error, code: recorded.code })
    }
  }

  // An open invoice in the reskontra: the retro-match looks for its payment
  // among the bank rows, and webhook subscribers learn of it.
  try {
    await eventBus.emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: registered, companyId, userId },
    })
  } catch (err) {
    log.warn('supplier_invoice.registered event emission failed', { supplierInvoiceId, error: err instanceof Error ? err.message : String(err) })
  }

  return { ok: true, supplierInvoiceId, arrivalNumber, plan }
}

/**
 * Remove a registration whose rows or payment could not be written. It was
 * inserted a moment ago and nothing refers to it yet; its rows and payment go
 * with it (ON DELETE CASCADE), so a retry is not refused as a number taken.
 */
async function undoRegistration(supabase: SupabaseClient, companyId: string, supplierInvoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('supplier_invoices')
    .delete()
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
  if (error) {
    log.error('registration rollback failed: the supplier invoice may be stranded without its rows', error, { companyId, supplierInvoiceId })
  }
}
