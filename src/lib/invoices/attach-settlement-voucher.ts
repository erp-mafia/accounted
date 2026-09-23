/**
 * Attach the verifikat that paid an ALREADY settled supplier invoice as the
 * evidence of that settlement.
 *
 * A provider migration imports the general ledger through SIE and the supplier
 * register through the provider API. An invoice the provider reports as settled
 * lands as 'paid' with no supplier_invoice_payments row: the provider names no
 * payment date and no payment voucher (Bokio publishes no payments endpoint for
 * supplier invoices). The supplier invoice page then shows no paying verifikat,
 * and the kontantmetoden year-end cut-off, which reads the rows and nothing
 * else, counts the invoice as a leverantörsskuld at year end.
 *
 * link_supplier_invoice_to_voucher cannot fill that gap: it RECORDS a payment
 * and rightly refuses a paid invoice. The rules for this other job live in one
 * place, the attach_supplier_invoice_settlement_voucher RPC (migration
 * 20260921084700). This module only:
 *
 *  - calls it for one pair;
 *  - resolves a batch written the way the customer knows their data (their
 *    supplier's invoice number, the verifikat number from the old system) to
 *    ids, with the same never-guess resolver the registration linker uses, and
 *    calls it pair by pair.
 *
 * The one write is the RPC's single payment row. Nothing here touches
 * supplier_invoices or the journal.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  buildVoucherIndex,
  fetchFiscalPeriods,
  fetchSourceRefVouchers,
  resolveDatedRef,
} from '@/lib/documents/voucher-ref-resolver'

const log = createLogger('attach-settlement-voucher')

export type AttachSettlementErrorCode =
  | 'ATTACH_SI_SETTLEMENT_NOTES_TOO_LONG'
  | 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND'
  | 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_FOUND'
  | 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED'
  | 'ATTACH_SI_SETTLEMENT_CREDIT_NOTE_UNSUPPORTED'
  | 'ATTACH_SI_SETTLEMENT_NOT_SETTLED'
  | 'ATTACH_SI_SETTLEMENT_CURRENCY_UNSUPPORTED'
  | 'ATTACH_SI_SETTLEMENT_NOT_POSTED'
  | 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE'
  | 'ATTACH_SI_SETTLEMENT_CUTOFF_ALREADY_POSTED'
  | 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN'
  | 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE'
  | 'ATTACH_SI_SETTLEMENT_VOUCHER_CURRENCY_UNSUPPORTED'
  | 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER'
  | 'ATTACH_SI_SETTLEMENT_DB_ERROR'

export interface AttachSettlementOk {
  ok: true
  dryRun: boolean
  /** null on a dry run: nothing was written. */
  paymentId: string | null
  supplierInvoiceId: string
  journalEntryId: string
  /** The verifikat's entry_date, which is the date the row carries. */
  paymentDate: string
  amount: number
  /** What is left of the verifikat's settlement side after this row. */
  voucherCapacityAfter: number
}

export interface AttachSettlementRefused {
  ok: false
  code: AttachSettlementErrorCode
  details?: Record<string, unknown>
}

export type AttachSettlementResult = AttachSettlementOk | AttachSettlementRefused

export interface AttachSettlementParams {
  companyId: string
  /** Real user id: written on the payment row (a user session overrides it with the JWT sub). */
  userId: string
  supplierInvoiceId: string
  journalEntryId: string
  notes?: string | null
  dryRun?: boolean
}

export async function attachSupplierInvoiceSettlementVoucher(
  supabase: SupabaseClient,
  params: AttachSettlementParams,
): Promise<AttachSettlementResult> {
  const { data, error } = await supabase.rpc('attach_supplier_invoice_settlement_voucher', {
    p_supplier_invoice_id: params.supplierInvoiceId,
    p_journal_entry_id: params.journalEntryId,
    p_user_id: params.userId,
    p_company_id: params.companyId,
    p_notes: params.notes ?? null,
    p_dry_run: params.dryRun ?? false,
  })

  if (error) {
    log.error('attach_supplier_invoice_settlement_voucher RPC error', {
      companyId: params.companyId,
      supplierInvoiceId: params.supplierInvoiceId,
      journalEntryId: params.journalEntryId,
      message: error.message,
    })
    return { ok: false, code: 'ATTACH_SI_SETTLEMENT_DB_ERROR', details: { reason: error.message } }
  }

  const result = (data ?? null) as Record<string, unknown> | null
  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, code: 'ATTACH_SI_SETTLEMENT_DB_ERROR', details: { reason: 'malformed RPC result' } }
  }
  if (!result.ok) {
    return {
      ok: false,
      code: result.code as AttachSettlementErrorCode,
      details: result.details as Record<string, unknown> | undefined,
    }
  }
  return {
    ok: true,
    dryRun: Boolean(result.dry_run),
    paymentId: (result.payment_id as string | null) ?? null,
    supplierInvoiceId: result.supplier_invoice_id as string,
    journalEntryId: result.journal_entry_id as string,
    paymentDate: result.payment_date as string,
    amount: Number(result.amount),
    voucherCapacityAfter: Number(result.voucher_capacity_after),
  }
}

/** One pair, written the way the customer knows their own data. */
export interface SettlementLinkInput {
  /** The supplier's invoice number, as registered on the invoice. */
  supplier_invoice_number: string
  /** Needed only when two invoices share the number (two suppliers can both issue "1001"). */
  invoice_date?: string
  /** The verifikat as the OLD system numbered it, series and number: "V342". */
  voucher: string
  /**
   * The verifikat's date. Source systems restart numbering every fiscal year,
   * so "V342" alone names one verifikat per year; the date picks the year.
   */
  voucher_date: string
}

export type SettlementLinkOutcome =
  | 'attached'
  | 'would_attach'
  | 'already_linked'
  | 'invalid_input'
  | 'invoice_not_found'
  | 'invoice_ambiguous'
  | 'voucher_not_found'
  | 'refused'
  | 'error'

export interface SettlementLinkReport {
  /** Position in the submitted list, so a report line maps back to the customer's row. */
  index: number
  input: SettlementLinkInput
  outcome: SettlementLinkOutcome
  /** The RPC's refusal code for 'refused' / 'already_linked' / 'error'. */
  code?: AttachSettlementErrorCode
  /** Machine-readable one-liner for the run report. */
  reason?: string
  details?: Record<string, unknown>
  supplierInvoiceId?: string
  journalEntryId?: string
  amount?: number
  paymentDate?: string
}

export interface AttachSettlementBatchResult {
  dryRun: boolean
  total: number
  counts: Record<SettlementLinkOutcome, number>
  reports: SettlementLinkReport[]
}

export interface AttachSettlementBatchOptions {
  companyId: string
  userId: string
  links: SettlementLinkInput[]
  /** Preview against the real rules, writing nothing. Default false. */
  dryRun?: boolean
  /** Carried onto every row's notes after the fixed 'settlement-evidence' marker. */
  notes?: string | null
}

const VOUCHER_REF_RE = /^([A-Za-z]+)\s*(\d+)$/

/** "V342" / "v 342" to { series: 'V', number: 342 }; null when it is not a series plus a positive number. */
export function parseSourceVoucherRef(raw: unknown): { series: string; number: number } | null {
  if (typeof raw !== 'string') return null
  const match = VOUCHER_REF_RE.exec(raw.trim())
  if (!match) return null
  const number = Number(match[2])
  if (!Number.isSafeInteger(number) || number <= 0) return null
  return { series: match[1].toUpperCase(), number }
}

interface InvoiceKeyRow {
  id: string
  supplier_invoice_number: string | null
  invoice_date: string | null
}

function emptyCounts(): Record<SettlementLinkOutcome, number> {
  return {
    attached: 0,
    would_attach: 0,
    already_linked: 0,
    invalid_input: 0,
    invoice_not_found: 0,
    invoice_ambiguous: 0,
    voucher_not_found: 0,
    refused: 0,
    error: 0,
  }
}

/**
 * Resolve and attach a batch. Pairs run one at a time and in order: a batch
 * payment's capacity is shared between the invoices that name it, so order is
 * part of the result, and a support run has no reason to press the database.
 *
 * A dry run must agree with the run that follows it. The RPC judges each pair
 * against what is stored, and a dry run stores nothing, so two pairs that
 * compete (one verifikat, or one invoice) would both pass a naive preview and
 * the second would then be refused for real. The preview therefore keeps its
 * own tally of what it has planned and refuses the second pair the way the
 * real run will.
 */
export async function attachSettlementVouchersBatch(
  supabase: SupabaseClient,
  options: AttachSettlementBatchOptions,
): Promise<AttachSettlementBatchResult> {
  const { companyId, userId, links, dryRun = false, notes = null } = options

  const [invoiceRows, voucherRows, periods] = await Promise.all([
    fetchAllRows<InvoiceKeyRow>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchSourceRefVouchers(supabase, companyId),
    fetchFiscalPeriods(supabase, companyId),
  ])

  const invoicesByNumber = new Map<string, InvoiceKeyRow[]>()
  for (const row of invoiceRows) {
    const number = row.supplier_invoice_number?.trim()
    if (!number) continue
    const list = invoicesByNumber.get(number)
    if (list) list.push(row)
    else invoicesByNumber.set(number, [row])
  }
  const voucherIndex = buildVoucherIndex(voucherRows)

  const plannedByVoucher = new Map<string, number>()
  const plannedInvoices = new Set<string>()
  const reports: SettlementLinkReport[] = []

  for (const [index, input] of links.entries()) {
    const number = typeof input?.supplier_invoice_number === 'string' ? input.supplier_invoice_number.trim() : ''
    const ref = parseSourceVoucherRef(input?.voucher)
    const voucherDate = typeof input?.voucher_date === 'string' ? input.voucher_date.trim() : ''
    const invoiceDate = typeof input?.invoice_date === 'string' ? input.invoice_date.trim() : ''

    if (!number || !ref || !ISO_DATE_RE.test(voucherDate) || (invoiceDate && !ISO_DATE_RE.test(invoiceDate))) {
      reports.push({
        index,
        input,
        outcome: 'invalid_input',
        reason: !number
          ? 'supplier_invoice_number is missing'
          : !ref
            ? 'voucher must be a series and a positive number, like V342'
            : !ISO_DATE_RE.test(voucherDate)
              ? 'voucher_date must be YYYY-MM-DD'
              : 'invoice_date must be YYYY-MM-DD',
      })
      continue
    }

    const sameNumber = invoicesByNumber.get(number) ?? []
    const invoiceMatches = invoiceDate
      ? sameNumber.filter((row) => (row.invoice_date ?? '').slice(0, 10) === invoiceDate)
      : sameNumber
    if (invoiceMatches.length === 0) {
      reports.push({ index, input, outcome: 'invoice_not_found', reason: 'no supplier invoice carries this number' + (invoiceDate ? ' on this date' : '') })
      continue
    }
    if (invoiceMatches.length > 1) {
      reports.push({
        index,
        input,
        outcome: 'invoice_ambiguous',
        reason: invoiceDate
          ? `${invoiceMatches.length} supplier invoices carry this number on this date`
          : `${invoiceMatches.length} supplier invoices carry this number: add invoice_date`,
      })
      continue
    }
    const supplierInvoiceId = invoiceMatches[0].id

    // Same resolution the registration linker uses: the date picks the fiscal
    // year, and a ref that is missing or names two verifikat there is undefined.
    const journalEntryId = resolveDatedRef(voucherIndex, periods, { ...ref, date: voucherDate })
    if (!journalEntryId) {
      reports.push({
        index,
        input,
        outcome: 'voucher_not_found',
        supplierInvoiceId,
        reason: `no single imported verifikat carries ${ref.series}${ref.number} in the fiscal year of ${voucherDate}`,
      })
      continue
    }

    if (dryRun && plannedInvoices.has(supplierInvoiceId)) {
      reports.push({
        index,
        input,
        outcome: 'refused',
        code: 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN',
        supplierInvoiceId,
        journalEntryId,
        reason: 'an earlier pair in this batch already explains the whole settlement',
      })
      continue
    }

    const result = await attachSupplierInvoiceSettlementVoucher(supabase, {
      companyId,
      userId,
      supplierInvoiceId,
      journalEntryId,
      notes,
      dryRun,
    })

    if (!result.ok) {
      const outcome: SettlementLinkOutcome =
        result.code === 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED'
          ? 'already_linked'
          : result.code === 'ATTACH_SI_SETTLEMENT_DB_ERROR'
            ? 'error'
            : 'refused'
      reports.push({ index, input, outcome, code: result.code, details: result.details, supplierInvoiceId, journalEntryId })
      continue
    }

    if (dryRun) {
      const planned = plannedByVoucher.get(journalEntryId) ?? 0
      const capacityBefore = roundOre(result.voucherCapacityAfter + result.amount)
      if (roundOre(planned + result.amount) > capacityBefore + ORE_TOLERANCE) {
        reports.push({
          index,
          input,
          outcome: 'refused',
          code: 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
          supplierInvoiceId,
          journalEntryId,
          reason: 'earlier pairs in this batch already use the verifikat up',
          details: { unexplained: result.amount, capacity: roundOre(capacityBefore - planned), planned_in_batch: planned },
        })
        continue
      }
      plannedByVoucher.set(journalEntryId, roundOre(planned + result.amount))
      plannedInvoices.add(supplierInvoiceId)
    }

    reports.push({
      index,
      input,
      outcome: dryRun ? 'would_attach' : 'attached',
      supplierInvoiceId,
      journalEntryId,
      amount: result.amount,
      paymentDate: result.paymentDate,
    })
  }

  const counts = emptyCounts()
  for (const report of reports) counts[report.outcome] += 1
  log.info('settlement voucher batch finished', { companyId, dryRun, total: links.length, ...counts })
  return { dryRun, total: links.length, counts, reports }
}
