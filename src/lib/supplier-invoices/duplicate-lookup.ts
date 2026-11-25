/**
 * Before a supplier invoice is registered: is its number, or its payment
 * reference, already on a live invoice of the same supplier?
 *
 * The number is unique per supplier among live invoices
 * (idx_supplier_invoices_company_supplier_number), so a hit there is the
 * invoice the create route will refuse. A payment reference has no such
 * rule, and must not get one: a supplier that invoices through a
 * fakturaservice prints the same OCR on every invoice. So the reference only
 * warns, and how loudly depends on what the supplier's own invoices say:
 *
 *   - on ONE other live invoice it may be the same invoice registered under
 *     another number: a person acknowledges it before registering;
 *   - on two or more it is how this supplier invoices: nothing is asked,
 *     unless one of them is the same document again (isSameDocumentAgain:
 *     the same invoice date, currency and amount to pay). A constant OCR
 *     cannot tell that one from the next period's invoice; the date and the
 *     amount can, so it is asked about whatever the count. An insurer that
 *     reuses its reference sends its next invoice on another date.
 *
 * Every invoice an answer names says where its payment stands
 * (registeredInvoicePayment), so a person can tell whether registering the
 * document again would pay it twice.
 *
 * Live is the unique index's own predicate: not credited, not reversed.
 * References are compared on their digits (normalizeOcrReference), as every
 * matcher compares them, so an OCR typed in groups is the same reference. A
 * reference without a digit is free text and is not looked for.
 *
 * The supplier is the supplier card (supplier_id). suppliers.org_number is
 * not unique per company (20260908094409), so two cards of one legal entity
 * are two suppliers here, as they are to the unique index.
 *
 * Advisory only: the editor asks through GET /api/supplier-invoices/exists
 * (its query: duplicate-lookup-query.ts), and no door refuses a reused
 * reference.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { supplierInvoiceDisplayFigures } from '@/lib/bookkeeping/supplier-invoice-display-figures'
import { dbError } from '@/lib/errors/db-error'
import { normalizeOcrReference } from '@/lib/invariants/reference-number'
import { equalOre } from '@/lib/money'
import { loadOpenPaymentInstructions } from './lifecycle-stages'
import { openPaymentMarker, SETTLED_SUPPLIER_INVOICE_STATUSES, type BankEnteredFacts, type OpenPaymentInstruction } from './stages'

/**
 * Where the payment of an invoice a warning names stands: paid (on the day
 * it was, when that is known), on its way, partly paid, or not paid.
 */
export type RegisteredInvoicePayment =
  | { state: 'paid'; paid_at: string | null }
  | { state: 'in_payment' }
  | { state: 'partially_paid'; paid_amount: number }
  | { state: 'unpaid' }

/** The invoice that already carries the number or the reference, as a warning names it. */
export interface RegisteredSupplierInvoice {
  id: string
  /** Null when the document carried none: arrival_number then names it. */
  supplier_invoice_number: string | null
  arrival_number: number
  invoice_date: string
  /** Total incl. VAT; shown through supplierInvoiceDisplayFigures with ore_rounding. */
  total: number
  currency: string
  /** Per-invoice öresavrundning flag: decides the amount the invoice list shows. */
  ore_rounding: boolean | null
  status: string
  /**
   * The verifikat it is booked on: the registration, else the payment (under
   * kontantmetoden the payment is the booking). Null while it is not booked.
   */
  voucher: { journal_entry_id: string; label: string } | null
  /** Where its payment stands (registeredInvoicePayment). */
  payment: RegisteredInvoicePayment
}

export interface SupplierInvoiceReferenceReuse {
  /** The newest other live invoice of the supplier that carries the reference. */
  invoice: RegisteredSupplierInvoice
  /** How many other live invoices of the supplier carry it. */
  count: number
  /**
   * The one among them that is the same document again (isSameDocumentAgain),
   * the newest when several are. Null when none is, or when the date and the
   * amount were not asked about.
   */
  twin: RegisteredSupplierInvoice | null
  /**
   * True on one other invoice (referenceReuseNeedsAcknowledgement), and on a
   * twin whatever the count.
   */
  needs_acknowledgement: boolean
}

export interface SupplierInvoiceDuplicateLookup {
  /** The live invoice of the supplier with this number, which the create route refuses. */
  number: RegisteredSupplierInvoice | null
  /** The reference on other live invoices of the supplier, under another number. */
  reference: SupplierInvoiceReferenceReuse | null
}

/** From this many invoices on one reference, reuse is how the supplier invoices. */
const ROUTINE_REFERENCE_REUSE_FROM = 2

/** A reference on one other invoice is acknowledged; on more it is the supplier's normal. */
export function referenceReuseNeedsAcknowledgement(count: number): boolean {
  return count > 0 && count < ROUTINE_REFERENCE_REUSE_FROM
}

/** What registeredInvoicePayment reads off an invoice. */
export interface RegisteredInvoicePaymentFacts extends BankEnteredFacts {
  paid_at?: string | null
  paid_amount?: number | null
  /** The open payment instructions covering it (loadOpenPaymentInstructions). */
  open_payment?: OpenPaymentInstruction | null
}

/**
 * Where an invoice's payment stands, from the rules the invoice list reads:
 * paid is its status, on its way is the I betalning tab's openPaymentMarker
 * (a bank payment, signed or not, the "Inlagd i banken" tick while it holds,
 * a payment file). A payment on its way is told before a part payment: what
 * is left is being paid then, and that is what a person must not pay again.
 */
export function registeredInvoicePayment(invoice: RegisteredInvoicePaymentFacts, today?: string): RegisteredInvoicePayment {
  if (invoice.status === 'paid') return { state: 'paid', paid_at: invoice.paid_at ?? null }
  if (openPaymentMarker(invoice, today) !== null) return { state: 'in_payment' }
  if (invoice.status === 'partially_paid') return { state: 'partially_paid', paid_amount: Number(invoice.paid_amount ?? 0) }
  return { state: 'unpaid' }
}

/** Rows a reference lookup reads: the LIKE below leaves the supplier's matches and little else. */
const REFERENCE_CANDIDATE_LIMIT = 200

const INVOICE_COLUMNS =
  'id, supplier_invoice_number, arrival_number, invoice_date, total, currency, ore_rounding, status, payment_reference, registration_journal_entry_id, payment_journal_entry_id, paid_at, paid_amount, remaining_amount, due_date, bank_entered_at, is_credit_note'

interface InvoiceRow {
  id: string
  supplier_invoice_number: string | null
  arrival_number: number
  invoice_date: string
  total: number
  currency: string | null
  ore_rounding: boolean | null
  status: string
  payment_reference: string | null
  registration_journal_entry_id: string | null
  payment_journal_entry_id: string | null
  paid_at: string | null
  paid_amount: number | null
  remaining_amount: number | null
  due_date: string | null
  bank_entered_at: string | null
  is_credit_note: boolean | null
}

interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
}

const bookedOn = (row: InvoiceRow): string | null => row.registration_journal_entry_id ?? row.payment_journal_entry_id

/** The invoice being registered, as the twin rule reads it. */
interface DocumentAsked {
  invoiceDate: string
  /** The amount to pay the editor shows for it. */
  total: number
  currency: string | null | undefined
}

/** A currency code as the twin rule compares it: no code is SEK, and case does not count. */
const currencyCode = (code: string | null | undefined): string => (code || 'SEK').trim().toUpperCase()

/**
 * The same document again: an invoice that shares the reference and has the
 * same invoice date, the same currency and the same amount to pay, to the
 * öre. The amount is the one the invoice list shows for it
 * (supplierInvoiceDisplayFigures, öresavrundning applied), which is the
 * payable the editor shows for the one being registered. There is no
 * invoice period to weigh: an invoice has none of its own, only its rows'
 * periodisering.
 */
function isSameDocumentAgain(row: InvoiceRow, asked: DocumentAsked): boolean {
  const currency = currencyCode(row.currency)
  return (
    row.invoice_date === asked.invoiceDate &&
    currency === currencyCode(asked.currency) &&
    equalOre(supplierInvoiceDisplayFigures({ total: Number(row.total), currency, ore_rounding: row.ore_rounding }).toPay, asked.total)
  )
}

/**
 * Look the number and the reference up among the supplier's live invoices.
 * Either may be absent. With the reference, the invoice date and the amount
 * to pay (both, or neither) look for the same document among the invoices
 * that share it. Served by the partial unique index (the number) and
 * idx_supplier_invoices_supplier (the reference: one supplier's invoices are
 * few, and the LIKE narrows them before they leave the database).
 */
export async function lookupSupplierInvoiceDuplicates(
  supabase: SupabaseClient,
  companyId: string,
  input: {
    supplierId: string
    number?: string | null
    reference?: string | null
    invoiceDate?: string | null
    total?: number | null
    /** Of the invoice being registered; SEK when not given. */
    currency?: string | null
  },
): Promise<SupplierInvoiceDuplicateLookup> {
  const number = (input.number ?? '').trim()
  const referenceDigits = normalizeOcrReference(input.reference)
  // The digits in order with anything between them: every reference that is
  // equal on its digits, and few others. Equality is decided below.
  const referencePattern = `%${[...referenceDigits].join('%')}%`
  // Under another number: the invoice with this number is the number's hit.
  const sharesTheReference = (row: InvoiceRow) =>
    normalizeOcrReference(row.payment_reference) === referenceDigits && (!number || row.supplier_invoice_number !== number)

  const [numberRes, referenceRes] = await Promise.all([
    number
      ? supabase
          .from('supplier_invoices')
          .select(INVOICE_COLUMNS)
          .eq('company_id', companyId)
          .eq('supplier_id', input.supplierId)
          .eq('supplier_invoice_number', number)
          .not('status', 'in', '(credited,reversed)')
          .limit(1)
      : Promise.resolve({ data: [], error: null }),
    referenceDigits
      ? supabase
          .from('supplier_invoices')
          .select(INVOICE_COLUMNS)
          .eq('company_id', companyId)
          .eq('supplier_id', input.supplierId)
          .not('status', 'in', '(credited,reversed)')
          .like('payment_reference', referencePattern)
          .order('invoice_date', { ascending: false })
          .order('arrival_number', { ascending: false })
          .limit(REFERENCE_CANDIDATE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (numberRes.error) throw dbError(numberRes.error)
  if (referenceRes.error) throw dbError(referenceRes.error)

  const numberRow = ((numberRes.data ?? []) as InvoiceRow[])[0] ?? null
  const candidates = (referenceRes.data ?? []) as InvoiceRow[]
  const sharing = candidates.filter(sharesTheReference)
  const referenceRow = sharing[0] ?? null
  const asked: DocumentAsked | null =
    input.invoiceDate && typeof input.total === 'number' && Number.isFinite(input.total)
      ? { invoiceDate: input.invoiceDate, total: input.total, currency: input.currency }
      : null
  // The newest one, as the rows are read.
  let twinRow = asked ? (sharing.find((row) => isSameDocumentAgain(row, asked)) ?? null) : null
  if (asked && !twinRow && candidates.length >= REFERENCE_CANDIDATE_LIMIT) {
    // The candidates stop at the newest few hundred: a twin older than them
    // is looked for on its own invoice date.
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select(INVOICE_COLUMNS)
      .eq('company_id', companyId)
      .eq('supplier_id', input.supplierId)
      .not('status', 'in', '(credited,reversed)')
      .eq('invoice_date', asked.invoiceDate)
      .like('payment_reference', referencePattern)
      .order('arrival_number', { ascending: false })
      .limit(REFERENCE_CANDIDATE_LIMIT)
    if (error) throw dbError(error)
    twinRow = ((data ?? []) as InvoiceRow[]).find((row) => sharesTheReference(row) && isSameDocumentAgain(row, asked)) ?? null
  }

  const namedRows = [numberRow, referenceRow, twinRow].filter((row): row is InvoiceRow => !!row)
  const voucherIds = namedRows.map(bookedOn).filter((id): id is string => !!id)
  // What a payment instruction may still cover: a settled invoice has nothing left to pay.
  const unsettledIds = namedRows.filter((row) => !SETTLED_SUPPLIER_INVOICE_STATUSES.has(row.status)).map((row) => row.id)
  const [voucherRes, openPayments] = await Promise.all([
    voucherIds.length > 0
      ? supabase
          .from('journal_entries')
          .select('id, voucher_series, voucher_number')
          .eq('company_id', companyId)
          .in('id', voucherIds)
      : Promise.resolve({ data: [], error: null }),
    loadOpenPaymentInstructions(supabase, companyId, unsettledIds),
  ])
  if (voucherRes.error) throw dbError(voucherRes.error)
  const vouchers = new Map<string, VoucherRow>()
  for (const entry of (voucherRes.data ?? []) as VoucherRow[]) vouchers.set(entry.id, entry)

  const named = (row: InvoiceRow): RegisteredSupplierInvoice => {
    const entry = vouchers.get(bookedOn(row) ?? '')
    return {
      id: row.id,
      supplier_invoice_number: row.supplier_invoice_number,
      arrival_number: row.arrival_number,
      invoice_date: row.invoice_date,
      total: Number(row.total),
      currency: row.currency ?? 'SEK',
      ore_rounding: row.ore_rounding ?? null,
      status: row.status,
      // A draft has no number yet: nothing to name.
      voucher: entry?.voucher_number ? { journal_entry_id: entry.id, label: formatVoucher(entry) } : null,
      payment: registeredInvoicePayment({ ...row, open_payment: openPayments.get(row.id) ?? null }),
    }
  }

  return {
    number: numberRow ? named(numberRow) : null,
    reference: referenceRow
      ? {
          invoice: named(referenceRow),
          count: sharing.length,
          twin: twinRow ? named(twinRow) : null,
          needs_acknowledgement: !!twinRow || referenceReuseNeedsAcknowledgement(sharing.length),
        }
      : null,
  }
}

/** Rows one number can name: the live holder and the credited originals it re-issues. */
const HOLDER_CANDIDATE_LIMIT = 20

/** The invoice a refused registration's number belongs to: details.existing of 409 SI_CREATE_DUPLICATE_INVOICE_NUMBER. */
export interface DuplicateNumberHolder {
  id: string
  supplier_invoice_number: string | null
  status: string
  /** Its credit note when it was credited, so the dashboard can offer "undo crediting". */
  credit_note_id: string | null
  /** When it was paid in full; null while it is not. */
  paid_at: string | null
  /** What is left to pay on it, in its own currency. */
  remaining_amount: number | null
  /** The verifikat it is booked on, as a warning names it; null while it is not booked. */
  voucher: { journal_entry_id: string; label: string } | null
}

/**
 * The invoice that holds the number a registration was refused for, read
 * after the unique index refused the insert, as every door answers it: the
 * dashboard and v1 create (supplier-invoices/create.ts) and the inbox convert
 * (operations/inbox-convert.ts). An agent or an API client that hits the stop
 * is told what the editor's warning tells a person: whether it is paid
 * already, and the verifikat it is on. Null when the row is gone (deleted
 * between the refused insert and this read).
 */
export async function readDuplicateNumberHolder(
  supabase: SupabaseClient,
  companyId: string,
  supplierId: string,
  number: string | null | undefined,
): Promise<DuplicateNumberHolder | null> {
  // A registration without a number cannot meet the index.
  if (!number) return null
  const { data } = await supabase
    .from('supplier_invoices')
    .select('id, supplier_invoice_number, status, paid_at, remaining_amount, registration_journal_entry_id, payment_journal_entry_id')
    .eq('company_id', companyId)
    .eq('supplier_id', supplierId)
    .eq('supplier_invoice_number', number)
    .limit(HOLDER_CANDIDATE_LIMIT)
  const rows = (data ?? []) as Array<
    Pick<
      InvoiceRow,
      'id' | 'supplier_invoice_number' | 'status' | 'paid_at' | 'remaining_amount' | 'registration_journal_entry_id' | 'payment_journal_entry_id'
    >
  >
  // The index's holder is the live one: a credited original of a re-issue
  // carries the same number, so one number can name several rows.
  const row = rows.find((candidate) => candidate.status !== 'credited' && candidate.status !== 'reversed') ?? rows[0]
  if (!row) return null

  let creditNoteId: string | null = null
  if (row.status === 'credited') {
    const { data: creditNote } = await supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('credited_invoice_id', row.id)
      .eq('is_credit_note', true)
      .maybeSingle()
    creditNoteId = (creditNote?.id as string | undefined) ?? null
  }

  let voucher: DuplicateNumberHolder['voucher'] = null
  const entryId = row.registration_journal_entry_id ?? row.payment_journal_entry_id
  if (entryId) {
    const { data: entry } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .eq('id', entryId)
      .maybeSingle()
    const booked = entry as VoucherRow | null
    // A draft has no number yet: nothing to name.
    if (booked?.voucher_number) voucher = { journal_entry_id: booked.id, label: formatVoucher(booked) }
  }

  return {
    id: row.id,
    supplier_invoice_number: row.supplier_invoice_number,
    status: row.status,
    credit_note_id: creditNoteId,
    paid_at: row.paid_at ?? null,
    remaining_amount: row.remaining_amount ?? null,
    voucher,
  }
}
