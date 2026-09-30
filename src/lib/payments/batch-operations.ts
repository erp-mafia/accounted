/**
 * Supplier payment batches (betalfil) as operations: the OperationOutcome
 * services behind src/lib/operations/supplier-payment-batches.ts and the
 * dashboard routes under /api/supplier-invoices/payment-batches, so the UI,
 * v1 and MCP run the same rules.
 *
 * The rules themselves (eligibility, debtor resolution, the transactional
 * create RPC, the deterministic pain.001 render) stay in ./batch-service.ts
 * and ./batch-eligibility.ts; this file adds the doors' needs: dry runs that
 * write nothing, the not-found / already-cancelled answers as registry
 * codes, and the reads shared by the list and detail views.
 *
 * Authorization mirrors the dashboard: creating, cancelling and downloading
 * a batch is open to every non-viewer member (the dashboard routes gate with
 * requireWrite, not requireAdmin), so no requireCompanyAdmin here. A batch
 * only produces a file; nothing leaves the company's account until someone
 * with access to the company's bank uploads and signs it there.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ORE_TOLERANCE } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { decodeDefaultCursor, nextCursorFromPage } from '@/lib/api/v1/pagination'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'
import {
  createSupplierPaymentBatch,
  payeeFingerprint,
  planSupplierPaymentBatch,
  renderSupplierPaymentBatchFile,
  type CreateBatchInput,
  type CreateBatchResult,
  type SupplierPaymentBatchPlan,
} from './batch-service'
import { formatPayeeLabel, type SupplierPayee } from './supplier-payee'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** A create/plan refusal as the registry code and details the dashboard has always answered. */
function createFailure(result: Exclude<CreateBatchResult, { ok: true }>): Failure {
  switch (result.code) {
    case 'debtor_incomplete':
      return { ok: false, code: 'SI_BATCH_DEBTOR_INCOMPLETE', details: { missing: result.missing } }
    case 'ineligible':
      return { ok: false, code: 'SI_BATCH_INELIGIBLE_INVOICE', details: { invoices: result.details } }
    case 'invalid_amount':
      return { ok: false, code: 'SI_BATCH_INVALID_AMOUNT', details: { invoices: result.details } }
    case 'amount_exceeds_remaining':
      return { ok: false, code: 'SI_BATCH_AMOUNT_EXCEEDS_REMAINING', details: { invoices: result.details } }
    case 'already_batched':
      return { ok: false, code: 'SI_BATCH_DUPLICATE_INVOICE', details: { invoices: result.details } }
    case 'payee_changed': {
      const names = [...new Set(result.details.map((line) => line.supplier_name))].join(', ')
      return {
        ok: false,
        code: 'SI_BATCH_PAYEE_CHANGED',
        messageSv:
          `Betalningsuppgifterna eller beloppet för ${names} har ändrats sedan betalfilen förbereddes. ` +
          'Förbered betalfilen igen och kontrollera mottagaren.',
        details: { invoices: result.details },
      }
    }
    default:
      return { ok: false, code: 'SI_BATCH_CREATE_FAILED' }
  }
}

/**
 * The payee as a staged preview shows it. Bankgiro and plusgiro are company
 * numbers and show in full; a bank account shows the clearing number and the
 * last four digits only, because a personkonto number is the holder's
 * personnummer and the preview is stored with the pending operation.
 */
function stagedPayeeLabel(payee: SupplierPayee): string {
  if (payee.type !== 'bank_account') return formatPayeeLabel(payee)
  return `${payee.clearing} ****${payee.account.slice(-4)}`
}

/** The dry-run answer for a create: the batch the commit would write, without id or MsgId. */
function planPreview(plan: SupplierPaymentBatchPlan, format: string): Record<string, unknown> {
  return {
    format,
    currency: 'SEK',
    item_count: plan.items.length,
    total_amount: plan.total_amount,
    debtor: { name: plan.debtor.name, iban: plan.debtor.iban, bic: plan.debtor.bic },
    items: plan.items.map((item, index) => ({
      supplier_invoice_id: item.supplier_invoice_id,
      amount: item.amount,
      payment_date: item.payment_date,
      payee_name: item.payee_name,
      payee: {
        type: item.payee_type,
        label: stagedPayeeLabel(payeeOf(item)),
        fingerprint: payeeFingerprint(payeeOf(item)),
      },
      reference: { type: item.reference_type, value: item.reference },
      warnings: plan.warnings[index] ?? [],
    })),
    note:
      'Nothing is created yet. The live call re-checks every invoice, creates the batch and mints its pain.001 MsgId; ' +
      'the file is then downloaded and uploaded to the bank, where the payment is signed. No verifikat is posted.',
  }
}

/**
 * Create a payment batch. The dry run runs every check the commit runs
 * (debtor, eligibility, amounts, the active-batch collision) and writes
 * nothing: no RPC, no id, no MsgId.
 */
export async function createPaymentBatch(
  ctx: OperationContext,
  input: CreateBatchInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<SupplierPaymentBatch>> {
  if (options.dryRun) {
    const planned = await planSupplierPaymentBatch(ctx.supabase, ctx.companyId, input)
    if (!planned.ok) return createFailure(planned)
    return { ok: true, dryRun: true, preview: planPreview(planned.plan, input.format) }
  }
  const result = await createSupplierPaymentBatch(ctx.supabase, ctx.companyId, ctx.userId, input)
  if (!result.ok) return createFailure(result)
  return { ok: true, data: result.batch, created: true }
}

export interface CancelledBatch {
  id: string
  status: string
  cancelled_at: string | null
}

/**
 * Cancel a batch. Compare-and-set on status='created' so two racing cancels
 * resolve to exactly one winner; the loser gets SI_BATCH_ALREADY_CANCELLED.
 * Cancelling only changes what Accounted will re-serve: a file already
 * uploaded to the bank is not recalled by this.
 */
export async function cancelPaymentBatch(
  ctx: OperationContext,
  batchId: string,
  options: { dryRun: boolean },
): Promise<OperationOutcome<CancelledBatch>> {
  const { supabase, companyId } = ctx

  if (options.dryRun) {
    const { data: existing } = await supabase
      .from('supplier_payment_batches')
      .select('id, status, item_count, total_amount, download_count')
      .eq('id', batchId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!existing) return { ok: false, code: 'SI_BATCH_NOT_FOUND' }
    if (existing.status !== 'created') return { ok: false, code: 'SI_BATCH_ALREADY_CANCELLED' }
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_payment_batch_id: existing.id,
        status: { from: 'created', to: 'cancelled' },
        item_count: existing.item_count,
        total_amount: existing.total_amount,
        file_downloaded: (existing.download_count ?? 0) > 0,
        note:
          'Cancelling stops Accounted from serving the file again and frees its invoices for a new batch. ' +
          'A file already uploaded to the bank is NOT recalled: stop the payment in the bank too.',
      },
    }
  }

  const { data: cancelled } = await supabase
    .from('supplier_payment_batches')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: ctx.userId,
    })
    .eq('id', batchId)
    .eq('company_id', companyId)
    .eq('status', 'created')
    .select('id, status, cancelled_at')
    .single()

  if (cancelled) return { ok: true, data: cancelled as CancelledBatch }

  const { data: existing } = await supabase
    .from('supplier_payment_batches')
    .select('id, status')
    .eq('id', batchId)
    .eq('company_id', companyId)
    .single()

  if (!existing) return { ok: false, code: 'SI_BATCH_NOT_FOUND' }
  return { ok: false, code: 'SI_BATCH_ALREADY_CANCELLED' }
}

export interface BatchItemWithInvoice extends SupplierPaymentBatchItem {
  invoice: {
    id: string
    status: string
    remaining_amount: number
    supplier_invoice_number: string | null
    arrival_number: number | null
  } | null
}

/**
 * One batch with its items joined to the live invoice state (status +
 * remaining), so settlement shows per line without any stored progress
 * that could go stale.
 */
export async function getPaymentBatch(
  ctx: OperationContext,
  batchId: string,
): Promise<OperationOutcome<{ batch: SupplierPaymentBatch; items: BatchItemWithInvoice[] }>> {
  const { supabase, companyId } = ctx
  const { data: batch } = await supabase
    .from('supplier_payment_batches')
    .select('*')
    .eq('id', batchId)
    .eq('company_id', companyId)
    .single()

  if (!batch) return { ok: false, code: 'SI_BATCH_NOT_FOUND' }

  const { data: items } = await supabase
    .from('supplier_payment_batch_items')
    .select(
      '*, invoice:supplier_invoices(id, status, remaining_amount, supplier_invoice_number, arrival_number)',
    )
    .eq('batch_id', batchId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  return {
    ok: true,
    data: {
      batch: batch as SupplierPaymentBatch,
      items: (items ?? []) as unknown as BatchItemWithInvoice[],
    },
  }
}

export interface BatchProgress {
  /** batch id -> number of member invoices with nothing left to pay. */
  settledCounts: Map<string, number>
  /** batch id -> member invoice ids, in item order. */
  invoiceIdsByBatch: Map<string, string[]>
}

/**
 * Settlement progress for a page of batches, derived from the live invoice
 * rows (never stored): settled = remaining_amount at or under the öre
 * epsilon. Paginated past PostgREST's 1000-row cap, since a page of 100
 * batches can hold up to 10 000 items.
 */
export async function loadBatchProgress(
  supabase: SupabaseClient,
  companyId: string,
  batchIds: string[],
): Promise<BatchProgress> {
  const settledCounts = new Map<string, number>()
  const invoiceIdsByBatch = new Map<string, string[]>()
  if (batchIds.length === 0) return { settledCounts, invoiceIdsByBatch }

  const items = await fetchAllRows<{ batch_id: string; supplier_invoice_id: string; invoice: unknown }>(
    ({ from, to }) =>
      supabase
        .from('supplier_payment_batch_items')
        .select('batch_id, supplier_invoice_id, invoice:supplier_invoices(remaining_amount)')
        .eq('company_id', companyId)
        .in('batch_id', batchIds)
        .order('id', { ascending: true })
        .range(from, to),
  )

  for (const item of items) {
    const invoice = item.invoice as { remaining_amount: number } | null
    if (invoice && invoice.remaining_amount <= ORE_TOLERANCE) {
      settledCounts.set(item.batch_id, (settledCounts.get(item.batch_id) ?? 0) + 1)
    }
    const list = invoiceIdsByBatch.get(item.batch_id)
    if (list) list.push(item.supplier_invoice_id)
    else invoiceIdsByBatch.set(item.batch_id, [item.supplier_invoice_id])
  }
  return { settledCounts, invoiceIdsByBatch }
}

export interface BatchListPage {
  batches: SupplierPaymentBatch[]
  progress: BatchProgress
  nextCursor: string | null
}

/** Newest first, keyset-paginated on (created_at, id). A stale or corrupt cursor starts over. */
export async function listPaymentBatches(
  ctx: OperationContext,
  input: { status: 'created' | 'cancelled' | 'all'; limit: number; cursor?: string },
): Promise<OperationOutcome<BatchListPage>> {
  const { supabase, companyId } = ctx
  const decoded = decodeDefaultCursor(input.cursor)

  let query = supabase
    .from('supplier_payment_batches')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(input.limit + 1)
  if (input.status !== 'all') query = query.eq('status', input.status)
  if (decoded) {
    query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
  }

  const { data, error } = await query
  if (error) return { ok: false, code: 'INTERNAL_ERROR', error }

  const rows = (data ?? []) as SupplierPaymentBatch[]
  const nextCursor = nextCursorFromPage(rows, input.limit)
  const page = rows.slice(0, input.limit)
  const progress = await loadBatchProgress(supabase, companyId, page.map((batch) => batch.id))
  return { ok: true, data: { batches: page, progress, nextCursor } }
}

export interface DownloadedBatchFile {
  batch: SupplierPaymentBatch
  content: string
  contentType: string
  filename: string
  sha256: string
  downloadCount: number
}

/**
 * Render a batch's file for download and stamp the download on the batch
 * (file_generated_at, download_count). The file regenerates
 * deterministically from the stored rows: msg_id and created_at were fixed
 * at creation, so every download is byte-identical and the bank's duplicate
 * detection (keyed on MsgId) stays meaningful. The stamp is bookkeeping
 * about the batch, so a failed stamp never withholds the file.
 */
export async function downloadPaymentBatchFile(
  ctx: OperationContext,
  batchId: string,
): Promise<OperationOutcome<DownloadedBatchFile>> {
  const { supabase, companyId } = ctx
  const { data: batchRow } = await supabase
    .from('supplier_payment_batches')
    .select('*')
    .eq('id', batchId)
    .eq('company_id', companyId)
    .single()

  if (!batchRow) return { ok: false, code: 'SI_BATCH_NOT_FOUND' }
  const batch = batchRow as SupplierPaymentBatch
  if (batch.status === 'cancelled') return { ok: false, code: 'SI_BATCH_CANCELLED' }

  const { data: items } = await supabase
    .from('supplier_payment_batch_items')
    .select('*')
    .eq('batch_id', batchId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  if (!items || items.length === 0) return { ok: false, code: 'SI_BATCH_NOT_FOUND' }

  const rendered = renderSupplierPaymentBatchFile(batch, items as SupplierPaymentBatchItem[])
  const downloadCount = (batch.download_count ?? 0) + 1

  await supabase
    .from('supplier_payment_batches')
    .update({
      file_generated_at: new Date().toISOString(),
      download_count: downloadCount,
    })
    .eq('id', batchId)
    .eq('company_id', companyId)

  return {
    ok: true,
    data: {
      batch,
      content: rendered.content,
      contentType: rendered.contentType,
      filename: rendered.filename,
      sha256: createHash('sha256').update(rendered.content, 'utf8').digest('hex'),
      downloadCount,
    },
  }
}

/** The payee a stored item routes to, for its display label. */
export function payeeOf(
  item: Pick<SupplierPaymentBatchItem, 'payee_type' | 'payee_bankgiro' | 'payee_plusgiro' | 'payee_clearing' | 'payee_account'>,
): SupplierPayee {
  if (item.payee_type === 'bankgiro') return { type: 'bankgiro', bankgiro: item.payee_bankgiro ?? '' }
  if (item.payee_type === 'plusgiro') return { type: 'plusgiro', plusgiro: item.payee_plusgiro ?? '' }
  return { type: 'bank_account', clearing: item.payee_clearing ?? '', account: item.payee_account ?? '' }
}
