import type { SupabaseClient } from '@supabase/supabase-js'
import { setChecklistItem } from '@/lib/bokslut/checklist'
import { uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { stockholmWallTimeToUtc, todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { createSigningRequest, signingStartRefusal, type CreatedSigningRequest } from '@/lib/signing/requests'
import { createServiceClient } from '@/lib/supabase/server'
import { StockCountError, stockCountErrorFromDb } from './errors'
import {
  buildStockCountView,
  loadFiscalPeriod,
  loadStockCountRecord,
  loadStockCountRows,
  type StockCountRecord,
  type StockCountView,
} from './register'
import type { StockCountPdfInput } from './pdf'

const log = createLogger('bokslut/stock-count/signing')

/**
 * Signing the inventeringslista "på heder och samvete" (LIV 2 §), two ways:
 * with BankID where signing is open for the company (the archived PDF goes
 * through lib/signing like any document, and the count follows the request
 * once it completes), or by hand: the name and day on the paper list,
 * optionally with its scan. Either way the count is frozen from then on and
 * the bokslut checklist's inventory step is marked done with who and when.
 */

/** What the PDF says: the count, its rows and totals, the company. */
export async function stockCountPdfInput(
  supabase: SupabaseClient,
  companyId: string,
  view: StockCountView,
): Promise<StockCountPdfInput> {
  const [period, settings] = await Promise.all([
    loadFiscalPeriod(supabase, companyId, view.fiscal_period_id),
    supabase.from('company_settings').select('company_name, org_number').eq('company_id', companyId).maybeSingle(),
  ])
  const company = (settings.data ?? {}) as { company_name?: string | null; org_number?: string | null }
  return {
    companyName: company.company_name ?? null,
    orgNumber: company.org_number ?? null,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    balanceDate: view.balance_date,
    countDate: view.count_date,
    rollForwardNote: view.roll_forward_note,
    note: view.note,
    rows: view.rows,
    totals: view.totals,
    totalValue: view.total_value,
    signedBy: view.status === 'draft' ? null : view.signer_name,
    signedOn: view.status === 'draft' || !view.signed_at ? null : todayIsoStockholm(new Date(view.signed_at)),
    generatedAt: todayIsoStockholm(),
  }
}

export async function renderStockCountPdfFor(supabase: SupabaseClient, companyId: string, view: StockCountView): Promise<Buffer> {
  // Loaded on use: react-pdf stays out of every module that reaches the
  // register (the operation registry among them) until a list is rendered.
  const { renderStockCountPdf } = await import('./pdf')
  return renderStockCountPdf(await stockCountPdfInput(supabase, companyId, view))
}

/**
 * Mark the bokslut checklist's inventory step done for the count's year,
 * naming who signed and when. Best effort: the signed count is the record,
 * the checklist row only points at it.
 */
export async function markInventoryChecklistDone(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  record: Pick<StockCountRecord, 'fiscal_period_id' | 'signer_name' | 'signed_at'>,
): Promise<void> {
  try {
    const day = record.signed_at ? todayIsoStockholm(new Date(record.signed_at)) : todayIsoStockholm()
    await setChecklistItem(supabase, companyId, userId, record.fiscal_period_id, {
      item_key: 'inventory_valued',
      state: 'done',
      note: `Inventeringslista signerad ${day} av ${record.signer_name ?? ''}`.trim(),
    })
  } catch (err) {
    log.warn('inventory checklist step not marked', { companyId, message: err instanceof Error ? err.message : String(err) })
  }
}

function assertSignable(record: StockCountRecord, rowCount: number): void {
  if (record.status !== 'draft') throw new StockCountError('STOCK_COUNT_LOCKED')
  if (record.signing_request_id) throw new StockCountError('STOCK_COUNT_SIGNING_PENDING')
  if (rowCount === 0) throw new StockCountError('STOCK_COUNT_EMPTY')
}

export interface ManualSignInput {
  signerName: string
  signedOn: string
  /** The signed paper list, scanned. */
  file?: { name: string; buffer: ArrayBuffer; type: string } | null
}

/** Signed by hand: name and day, and the scan when there is one. */
export async function signStockCountManually(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  id: string,
  input: ManualSignInput,
): Promise<StockCountView> {
  const record = await loadStockCountRecord(supabase, companyId, id)
  const rows = await loadStockCountRows(supabase, companyId, id)
  assertSignable(record, rows.length)

  let signedDocumentId: string | null = null
  if (input.file) {
    const invalid = validateDocumentFile({ size: input.file.buffer.byteLength, type: input.file.type })
    if (invalid) throw new StockCountError('STOCK_COUNT_FILE_INVALID', { reason: invalid })
    const document = await uploadDocument(supabase, userId, companyId, input.file, {
      upload_source: 'file_upload',
      extractionOwner: 'none',
    })
    signedDocumentId = document.id
  }

  const signedAt = input.signedOn === todayIsoStockholm()
    ? new Date().toISOString()
    : stockholmWallTimeToUtc(input.signedOn, '12:00').toISOString()
  const { data, error } = await supabase
    .from('inventory_counts')
    .update({ status: 'signed', signer_name: input.signerName.trim(), signed_at: signedAt, signed_document_id: signedDocumentId })
    .eq('company_id', companyId)
    .eq('id', id)
    .eq('status', 'draft')
    .select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at')
    .maybeSingle()
  if (error) throw stockCountErrorFromDb(error) ?? error
  if (!data) throw new StockCountError('STOCK_COUNT_LOCKED')
  const signed = data as unknown as StockCountRecord
  await markInventoryChecklistDone(supabase, companyId, userId, signed)
  return buildStockCountView(signed, rows)
}

export interface BankIdSignInput {
  signerName: string
  email?: string | null
}

/**
 * Send the list for BankID signing: the PDF is rendered and archived, one
 * signer (the member asking, locked to their own BankID when they log in
 * with one) gets a link, and the count is frozen while the request runs.
 */
export async function requestStockCountBankIdSignature(
  ctx: OperationContext,
  id: string,
  input: BankIdSignInput,
): Promise<OperationOutcome<CreatedSigningRequest>> {
  const refusal = await signingStartRefusal(ctx.supabase, ctx.companyId)
  if (refusal) return { ok: false, code: refusal }
  const record = await loadStockCountRecord(ctx.supabase, ctx.companyId, id)
  const rows = await loadStockCountRows(ctx.supabase, ctx.companyId, id)
  assertSignable(record, rows.length)

  const view = buildStockCountView(record, rows)
  const pdf = await renderStockCountPdfFor(ctx.supabase, ctx.companyId, view)
  const { stockCountPdfFilename } = await import('./pdf')
  const archived = await uploadDocument(
    createServiceClient(),
    ctx.userId,
    ctx.companyId,
    { name: stockCountPdfFilename(record.balance_date), buffer: new Uint8Array(pdf).buffer as ArrayBuffer, type: 'application/pdf' },
    { upload_source: 'system', extractionOwner: 'none' },
  )
  const outcome = await createSigningRequest(ctx, {
    documentId: archived.id,
    title: `Inventeringslista per ${record.balance_date}`,
    message: null,
    sendEmail: Boolean(input.email),
    createdVia: 'app',
    signers: [{ name: input.signerName.trim(), email: input.email ?? null, roleLabel: null, userId: ctx.userId }],
  })
  if (!outcome.ok || outcome.dryRun) return outcome

  const { error } = await ctx.supabase
    .from('inventory_counts')
    .update({ signing_request_id: outcome.data.signing_request_id })
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .eq('status', 'draft')
  if (error) throw stockCountErrorFromDb(error) ?? error
  return outcome
}

interface SigningRequestState {
  status: 'open' | 'completed' | 'declined' | 'cancelled'
  expires_at: string
  completed_at: string | null
  signed_document_id: string | null
}

/** The columns a sync changes; a key left undefined keeps its column. */
interface SigningSyncPatch {
  status?: 'signed'
  signer_name?: string
  signed_at?: string
  signed_document_id?: string | null
  signing_request_id?: null
}

/**
 * Bring a count in line with its BankID request: completed signs the count
 * (the signer's BankID name, the time, the signed copy), declined, cancelled
 * or expired opens the draft again. A later read fills in the signed copy if
 * the seal was still running. Answers the record as it now stands; a write
 * the caller may not make (a viewer reading) leaves it as it was.
 */
export async function syncStockCountSigning(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  record: StockCountRecord,
): Promise<StockCountRecord> {
  if (!record.signing_request_id) return record
  if (record.status !== 'draft' && record.signed_document_id) return record

  const { data, error } = await supabase
    .from('signing_requests')
    .select('status, expires_at, completed_at, signed_document_id')
    .eq('company_id', companyId)
    .eq('id', record.signing_request_id)
    .maybeSingle()
  if (error) {
    log.warn('signing request unreadable for the count', { countId: record.id, message: error.message })
    return record
  }
  const request = data as SigningRequestState | null

  let patch: SigningSyncPatch | null = null
  if (request?.status === 'completed') {
    if (record.status === 'draft') {
      const { data: signer } = await supabase
        .from('signing_request_signers')
        .select('name, bankid_given_name, bankid_surname, signed_at')
        .eq('company_id', companyId)
        .eq('signing_request_id', record.signing_request_id)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle()
      const s = (signer ?? {}) as { name?: string; bankid_given_name?: string | null; bankid_surname?: string | null; signed_at?: string | null }
      const bankIdName = [s.bankid_given_name, s.bankid_surname].filter(Boolean).join(' ').trim()
      patch = {
        status: 'signed',
        signer_name: bankIdName || s.name || record.signer_name || 'BankID',
        signed_at: s.signed_at ?? request.completed_at ?? new Date().toISOString(),
        signed_document_id: request.signed_document_id,
      }
    } else if (request.signed_document_id) {
      patch = { signed_document_id: request.signed_document_id }
    }
  } else if (record.status === 'draft') {
    const expired = request?.status === 'open' && new Date(request.expires_at).getTime() <= Date.now()
    if (!request || request.status === 'declined' || request.status === 'cancelled' || expired) {
      patch = { signing_request_id: null }
    }
  }
  if (!patch) return record

  const { data: updated, error: updateError } = await supabase
    .from('inventory_counts')
    // A key left undefined is not sent (JSON drops it): its column stays as it is.
    .update({
      status: patch.status,
      signer_name: patch.signer_name,
      signed_at: patch.signed_at,
      signed_document_id: patch.signed_document_id,
      signing_request_id: patch.signing_request_id,
    })
    .eq('company_id', companyId)
    .eq('id', record.id)
    .eq('status', record.status)
    .select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at')
    .maybeSingle()
  if (updateError || !updated) {
    if (updateError) log.warn('count not synced with its signing request', { countId: record.id, message: updateError.message })
    return record
  }
  const next = updated as unknown as StockCountRecord
  if (record.status === 'draft' && next.status === 'signed') await markInventoryChecklistDone(supabase, companyId, userId, next)
  return next
}

/** One count with its rows, in step with its BankID request. */
export async function getStockCount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  id: string,
): Promise<StockCountView> {
  const record = await syncStockCountSigning(supabase, companyId, userId, await loadStockCountRecord(supabase, companyId, id))
  return buildStockCountView(record, await loadStockCountRows(supabase, companyId, id))
}
