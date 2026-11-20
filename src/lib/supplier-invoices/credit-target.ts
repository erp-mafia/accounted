/**
 * Which registered supplier invoice a supplier's credit note credits
 * (issue #2980).
 *
 * A kreditfaktura must reference the invoice it changes (ML 17 kap 22 §),
 * so the referenced invoice number is the strong key. Without one, the same
 * supplier and the same amount is the fallback. Nothing here is decided
 * silently: a single fit is a proposal the person confirms with Kreditera
 * (or the approver of a staged operation), several fits are handed back as
 * candidates to choose between, and a credit note that covers only part of
 * the invoice is never routed to the full credit.
 *
 * `pickCreditTarget` is pure (tested without a database); the loaders around
 * it read the pool and the credit note's reading.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'
import { matchSupplierByIdentity, supplierIdentityFrom } from '@/lib/suppliers/match-supplier'

/** What the inbox read off the credit note, as far as finding its invoice needs. */
export interface CreditNoteReading {
  /** The supplier the credit note is from, when resolved. */
  supplierId: string | null
  /** The invoice number the credit note references (creditedInvoiceNumber). */
  referencedNumber: string | null
  /** The credit note's total as read, any sign; null when not read. */
  total: number | null
  currency: string | null
}

export interface CreditTargetCandidate {
  supplier_invoice_id: string
  supplier_invoice_number: string | null
  arrival_number: number | null
  supplier_id: string
  supplier_name: string | null
  invoice_date: string
  status: string
  currency: string
  total: number
}

/**
 * - matched: one invoice, and the credit note is for its whole amount.
 * - partial: one invoice, but the credit note is for less than its total.
 * - amount_differs: one invoice, but the amount could not be read, exceeds
 *   the invoice or is in another currency.
 * - already_credited: the referenced invoice is credited already.
 * - ambiguous: several invoices fit; candidates holds them.
 * - none: nothing fits; candidates holds the supplier's invoices that can
 *   still be credited, for a person to pick from.
 */
export type CreditTargetStatus = 'matched' | 'partial' | 'amount_differs' | 'already_credited' | 'ambiguous' | 'none'

export interface CreditTargetResolution {
  status: CreditTargetStatus
  matched_on: 'invoice_number' | 'supplier_amount' | null
  invoice: CreditTargetCandidate | null
  candidates: CreditTargetCandidate[]
  /** The credit note's amount as a positive figure; null when not read. */
  credit_total: number | null
}

/** How many of a supplier's invoices a 'none' answer offers to pick from. */
export const CREDIT_TARGET_PICK_LIMIT = 10

/**
 * Invoice numbers as people and OCR write them: case, spaces and a leading
 * '#' or leading zeros do not make a different invoice.
 */
export function normalizeInvoiceNumber(value: string | null | undefined): string {
  const compact = (value ?? '').toUpperCase().replace(/\s+/g, '').replace(/^#/, '')
  return /^\d+$/.test(compact) ? compact.replace(/^0+(?=\d)/, '') : compact
}

/** The credit note's amount as a positive figure, or null when there is none to compare. */
export function creditAmount(total: number | null | undefined): number | null {
  if (typeof total !== 'number' || !Number.isFinite(total) || total === 0) return null
  return roundOre(Math.abs(total))
}

const creditable = (candidate: CreditTargetCandidate): boolean =>
  candidate.status !== 'credited' && candidate.status !== 'reversed'

const sameCurrency = (candidate: CreditTargetCandidate, currency: string | null): boolean =>
  !currency || candidate.currency.toUpperCase() === currency.toUpperCase()

/**
 * How a credit note's amount relates to one invoice: 'full' only when the
 * currencies agree and the amounts are equal to the öre.
 */
export function compareCreditToInvoice(
  credit: { total: number | null; currency: string | null },
  invoice: { total: number; currency: string },
): 'full' | 'partial' | 'amount_missing' | 'currency' | 'exceeds' {
  const amount = creditAmount(credit.total)
  if (amount === null) return 'amount_missing'
  if (credit.currency && credit.currency.toUpperCase() !== invoice.currency.toUpperCase()) return 'currency'
  const invoiceTotal = roundOre(invoice.total)
  if (amount === invoiceTotal) return 'full'
  return amount < invoiceTotal ? 'partial' : 'exceeds'
}

export function pickCreditTarget(pool: CreditTargetCandidate[], reading: CreditNoteReading): CreditTargetResolution {
  const credit_total = creditAmount(reading.total)
  const base = { credit_total }

  const reference = normalizeInvoiceNumber(reading.referencedNumber)
  if (reference) {
    const byNumber = pool.filter(
      (c) =>
        normalizeInvoiceNumber(c.supplier_invoice_number) === reference &&
        (!reading.supplierId || c.supplier_id === reading.supplierId),
    )
    const open = byNumber.filter(creditable)
    if (open.length === 1) {
      const invoice = open[0]
      const verdict = compareCreditToInvoice(reading, invoice)
      const status: CreditTargetStatus =
        verdict === 'full' ? 'matched' : verdict === 'partial' ? 'partial' : 'amount_differs'
      return { ...base, status, matched_on: 'invoice_number', invoice, candidates: [invoice] }
    }
    if (open.length > 1) return { ...base, status: 'ambiguous', matched_on: null, invoice: null, candidates: open }
    if (byNumber.length > 0) {
      return { ...base, status: 'already_credited', matched_on: 'invoice_number', invoice: byNumber[0], candidates: [] }
    }
  }

  const supplierOpen = reading.supplierId
    ? pool.filter((c) => c.supplier_id === reading.supplierId && creditable(c))
    : []
  if (credit_total !== null && supplierOpen.length > 0) {
    const sameAmount = supplierOpen.filter(
      (c) => sameCurrency(c, reading.currency) && roundOre(c.total) === credit_total,
    )
    if (sameAmount.length === 1) {
      return { ...base, status: 'matched', matched_on: 'supplier_amount', invoice: sameAmount[0], candidates: sameAmount }
    }
    if (sameAmount.length > 1) {
      return { ...base, status: 'ambiguous', matched_on: null, invoice: null, candidates: sameAmount }
    }
  }

  return {
    ...base,
    status: 'none',
    matched_on: null,
    invoice: null,
    candidates: supplierOpen.slice(0, CREDIT_TARGET_PICK_LIMIT),
  }
}

type PoolRow = {
  id: string
  supplier_id: string
  supplier_invoice_number: string | null
  arrival_number: number | null
  invoice_date: string
  status: string
  currency: string
  total: number | string
  supplier: { name: string | null } | Array<{ name: string | null }> | null
}

const POOL_COLUMNS =
  'id, supplier_id, supplier_invoice_number, arrival_number, invoice_date, status, currency, total, supplier:suppliers(name)'

/** Bound on the supplier pool: the newest invoices, where an unhandled credit note's original sits. */
const POOL_LIMIT = 500

function toCandidate(row: PoolRow): CreditTargetCandidate {
  const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier
  return {
    supplier_invoice_id: row.id,
    supplier_invoice_number: row.supplier_invoice_number,
    arrival_number: row.arrival_number,
    supplier_id: row.supplier_id,
    supplier_name: supplier?.name ?? null,
    invoice_date: row.invoice_date,
    status: row.status,
    currency: row.currency,
    total: Number(row.total),
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * The invoices a credit note could credit: the supplier's (newest first)
 * when the supplier is known, else the company's invoices carrying the
 * referenced number. Credit notes and non-positive rows are never targets.
 */
async function loadCreditTargetPool(
  supabase: SupabaseClient,
  companyId: string,
  reading: CreditNoteReading,
): Promise<CreditTargetCandidate[]> {
  const base = () =>
    supabase
      .from('supplier_invoices')
      .select(POOL_COLUMNS)
      .eq('company_id', companyId)
      .eq('is_credit_note', false)
      .gt('total', 0)
  let rows: PoolRow[] = []
  if (reading.supplierId) {
    const { data, error } = await base()
      .eq('supplier_id', reading.supplierId)
      .order('invoice_date', { ascending: false })
      .limit(POOL_LIMIT)
    if (error) throw error
    rows = (data ?? []) as PoolRow[]
  } else if (reading.referencedNumber?.trim()) {
    const { data, error } = await base()
      .ilike('supplier_invoice_number', escapeLikePattern(reading.referencedNumber.trim()))
      .limit(50)
    if (error) throw error
    rows = (data ?? []) as PoolRow[]
  }
  return rows.map(toCandidate)
}

export async function resolveCreditTarget(
  supabase: SupabaseClient,
  companyId: string,
  reading: CreditNoteReading,
): Promise<CreditTargetResolution> {
  const pool = await loadCreditTargetPool(supabase, companyId, reading)
  return pickCreditTarget(pool, reading)
}

// ---------------------------------------------------------------------------
// The inbox side: a credit note read from an inbox item
// ---------------------------------------------------------------------------

export interface InboxCreditNoteSource {
  matched_supplier_id?: string | null
  extracted_data?: Record<string, unknown> | null
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * The credit note's figures from an inbox reading. The total is the printed
 * total; when only the net and the VAT were read, their magnitudes add up to
 * it (the reported case read a positive total over a negative net and VAT,
 * so signs are not to be trusted, magnitudes are).
 */
export function creditNoteFromReading(extracted: Record<string, unknown> | null | undefined): {
  total: number | null
  currency: string | null
  referencedNumber: string | null
  creditNoteNumber: string | null
  creditNoteDate: string | null
} {
  const invoice = (extracted?.invoice ?? {}) as Record<string, unknown>
  const totals = (extracted?.totals ?? {}) as Record<string, unknown>
  const total = finite(totals.total)
  const subtotal = finite(totals.subtotal)
  const vat = finite(totals.vatAmount)
  const summed = subtotal !== null && vat !== null ? roundOre(Math.abs(subtotal) + Math.abs(vat)) : null
  const date = text(invoice.invoiceDate)
  return {
    total: total !== null && total !== 0 ? total : summed,
    currency: text(invoice.currency),
    referencedNumber: text(invoice.creditedInvoiceNumber),
    creditNoteNumber: text(invoice.invoiceNumber),
    creditNoteDate: date && ISO_DATE_RE.test(date) ? date : null,
  }
}

/**
 * Resolve the invoice an inbox credit note credits. The supplier is the one
 * picked on the item, else the one the reading identifies; `supplierId`
 * overrides both (an agent that already knows it).
 */
export async function resolveInboxCreditTarget(
  supabase: SupabaseClient,
  companyId: string,
  item: InboxCreditNoteSource,
  options: { supplierId?: string | null } = {},
): Promise<CreditTargetResolution> {
  const reading = creditNoteFromReading(item.extracted_data)
  let supplierId = options.supplierId ?? item.matched_supplier_id ?? null
  if (!supplierId) {
    const match = await matchSupplierByIdentity(
      supabase,
      companyId,
      supplierIdentityFrom((item.extracted_data as { supplier?: unknown } | null)?.supplier),
    )
    supplierId = match?.supplierId ?? null
  }
  return resolveCreditTarget(supabase, companyId, {
    supplierId,
    referencedNumber: reading.referencedNumber,
    total: reading.total,
    currency: reading.currency,
  })
}
