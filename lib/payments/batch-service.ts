/**
 * Supplier payment batch orchestration: preview, create, render.
 *
 * A batch is an immutable snapshot of payment instructions. Preview and create
 * share evaluateInvoiceForBatch so nothing can be created that the preview
 * would not have shown; create re-reads and re-evaluates every invoice so a
 * row that changed since the preview (settled meanwhile, supplier edited) is
 * rejected rather than paid on stale terms.
 *
 * The write itself is one transactional RPC (create_supplier_payment_batch):
 * it locks the selected invoices, re-checks active batches inside the
 * transaction, and inserts header + items atomically, so two concurrent
 * creates can never both land an active batch for the same invoice and a
 * header can never outlive its items (#1503).
 *
 * The file is rendered deterministically from the stored batch + item rows
 * alone: msg_id and created_at are fixed at creation, so every download of a
 * batch is byte-identical and bank-side duplicate detection (keyed on MsgId)
 * works. Generating or downloading a file books nothing and settles nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { redactString } from '@/lib/observability/redact'
import { getBranding } from '@/lib/branding/service'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import { ORE_TOLERANCE, roundOre, sumOre } from '@/lib/money'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import {
  lookupBicByClearing,
  lookupBicByBankName,
  normalizeBankNumber,
} from '@/lib/salary/payment/bank-account'
import {
  evaluateInvoiceForBatch,
  type BatchExclusionReason,
  type BatchInvoiceFacts,
  type BatchItemWarning,
} from './batch-eligibility'
import { formatPayeeLabel, type SupplierPayeeSource } from './supplier-payee'
import { generateSupplierPain001, type SupplierPain001Payment } from './pain001-supplier'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'

const log = createLogger('payments/batch-service')

const RPC_ERROR_TEXT_MAX = 500
const TRUNCATED = '[TRUNCATED]'
// Postgres quotes the entire failing row in `details` on CHECK and NOT NULL
// violations ("Failing row contains (..., SE45..., Anna Andersson, ...)").
// No pattern-based redactor catches a payee name, so the payload is dropped
// whole; the constraint name in `message` is the diagnostic anyway.
const FAILING_ROW_PATTERN = /Failing row contains \(.*\)/s

/**
 * Postgres/PostgREST error text (message, details, hint) can carry payment
 * data: a quoted failing row, an IBAN in a constraint message. Before any of
 * it reaches a log line it is (1) stripped of any failing-row payload,
 * (2) run through the repository's redactor (SE IBANs, personnummer, emails,
 * API keys) and (3) bounded, in that order: bounding first could cut an IBAN
 * into a fragment the pattern no longer recognises. The logger redacts again
 * on its own path; this keeps the guarantee local to the call site that knows
 * the text is payment-shaped (#2282 review). Non-strings become null.
 */
function boundedRedactedText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const redacted = redactString(value.replace(FAILING_ROW_PATTERN, 'Failing row contains ([ROW_OMITTED])'))
  if (redacted.length <= RPC_ERROR_TEXT_MAX) return redacted
  return `${redacted.slice(0, RPC_ERROR_TEXT_MAX - TRUNCATED.length)}${TRUNCATED}`
}

type InvoiceRow = BatchInvoiceFacts & {
  supplier: (SupplierPayeeSource & { id: string; name: string; city: string | null }) | null
}

const INVOICE_SELECT =
  'id, status, approved_at, due_date, remaining_amount, currency, is_credit_note, ' +
  'payment_reference, supplier_invoice_number, ' +
  'supplier:suppliers(id, name, city, bankgiro, plusgiro, bank_account, clearing_number, account_number)'

export interface BatchDebtor {
  name: string
  org_number: string
  iban: string
  bic: string
  /** Company bankgiro digits; enables the BGNR-to-BGNR debit Swedbank wants. */
  bankgiro: string | null
  /** Company town; Dbtr/PstlAdr/TwnNm (mandatory from Nov 2026 when present). */
  city: string | null
}

export type DebtorResolution =
  | { ok: true; debtor: BatchDebtor }
  | { ok: false; missing: 'iban' | 'bic' | 'org_number' }

/**
 * Resolve the paying company (pain.001 debtor) from settings, mirroring the
 * salary pain001 route: saved BIC first, then derivation from the clearing
 * number or bank name the company already entered, so most users only ever
 * fill in the IBAN. The org number is required: InitgPty must carry an OrgId
 * (Swedbank Validex PFH_002). The bankgiro rides along when valid so
 * bankgiro payees can be debited BGNR-to-BGNR.
 */
export async function resolveBatchDebtor(
  supabase: SupabaseClient,
  companyId: string,
): Promise<DebtorResolution> {
  const [{ data: company }, { data: settings }] = await Promise.all([
    supabase.from('companies').select('name, org_number').eq('id', companyId).single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, city, iban, bic, bankgiro, clearing_number, bank_name')
      .eq('company_id', companyId)
      .single(),
  ])

  const iban = (settings?.iban ?? '').replace(/\s/g, '').toUpperCase()
  if (!iban) return { ok: false, missing: 'iban' }

  const bic =
    settings?.bic?.trim() ||
    lookupBicByClearing(normalizeBankNumber(settings?.clearing_number)) ||
    lookupBicByBankName(settings?.bank_name)
  if (!bic) return { ok: false, missing: 'bic' }

  // Settings first: it is the maintained value; companies.org_number is the
  // write-once onboarding snapshot and may be empty.
  const orgNumber = settings?.org_number?.trim() || company?.org_number?.trim() || ''
  if (!orgNumber.replace(/\D/g, '')) return { ok: false, missing: 'org_number' }

  const bankgiroRaw = settings?.bankgiro ?? ''
  const bankgiro = validateBankgiroNumber(bankgiroRaw) ? bankgiroRaw.replace(/\D/g, '') : null

  return {
    ok: true,
    debtor: {
      name: settings?.company_name || company?.name || '',
      org_number: orgNumber,
      iban,
      bic,
      bankgiro,
      city: settings?.city?.trim() || null,
    },
  }
}

/**
 * invoice id -> id of the active (created) batch it already sits in.
 *
 * Fails CLOSED: a lookup error must abort the caller, because treating it as
 * "no active batches" would silently disable the duplicate-batch guard and
 * let a second payable file be created without confirm_already_batched.
 */
export async function loadActiveBatchMap(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('supplier_payment_batch_items')
    .select('supplier_invoice_id, batch:supplier_payment_batches!inner(id, status)')
    .eq('company_id', companyId)
    .eq('batch.status', 'created')

  if (error) throw error

  const map = new Map<string, string>()
  for (const row of data ?? []) {
    const batch = row.batch as unknown as { id: string }
    if (!map.has(row.supplier_invoice_id)) map.set(row.supplier_invoice_id, batch.id)
  }
  return map
}

export interface BatchPreviewLine {
  id: string
  supplier_name: string
  invoice_number: string
  amount: number
  payment_date: string
  payee: { type: string; label: string }
  reference: { type: 'ocr' | 'invoice_number'; value: string }
  warnings: BatchItemWarning[]
  active_batch_id: string | null
}

export interface BatchPreview {
  eligible: BatchPreviewLine[]
  excluded: Array<{ id: string; reason: BatchExclusionReason | 'not_found' }>
  total: number
  debtor_ok: boolean
  debtor_missing?: 'iban' | 'bic' | 'org_number'
}

export async function previewSupplierPaymentBatch(
  supabase: SupabaseClient,
  companyId: string,
  input: { ids: string[] },
): Promise<BatchPreview> {
  // Swedish calendar date, not UTC: between 00:00 and 01:59 Swedish summer
  // time a UTC slice is still yesterday, and "pay today" would produce an
  // execution date the bank rejects as passed.
  const today = getSwedishLocalDate()

  const [{ data: invoices }, activeBatchIdByInvoice, debtorResolution] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select(INVOICE_SELECT)
      .eq('company_id', companyId)
      .in('id', input.ids),
    loadActiveBatchMap(supabase, companyId),
    resolveBatchDebtor(supabase, companyId),
  ])

  const rows = (invoices ?? []) as unknown as InvoiceRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))

  const eligible: BatchPreviewLine[] = []
  const excluded: BatchPreview['excluded'] = []

  for (const id of input.ids) {
    const invoice = byId.get(id)
    if (!invoice || !invoice.supplier) {
      excluded.push({ id, reason: invoice ? 'payee_missing' : 'not_found' })
      continue
    }
    const evaluation = evaluateInvoiceForBatch(invoice, invoice.supplier, {
      today,
      activeBatchIdByInvoice,
    })
    if (!evaluation.eligible) {
      excluded.push({ id, reason: evaluation.reason })
      continue
    }
    eligible.push({
      id,
      supplier_name: invoice.supplier.name,
      invoice_number: invoice.supplier_invoice_number,
      amount: evaluation.defaults.amount,
      payment_date: evaluation.defaults.payment_date,
      payee: { type: evaluation.payee.type, label: formatPayeeLabel(evaluation.payee) },
      reference: evaluation.reference,
      warnings: evaluation.warnings,
      active_batch_id: evaluation.activeBatchId,
    })
  }

  const total = sumOre(eligible.map((line) => line.amount))

  return {
    eligible,
    excluded,
    total,
    debtor_ok: debtorResolution.ok,
    ...(debtorResolution.ok ? {} : { debtor_missing: debtorResolution.missing }),
  }
}

export interface CreateBatchItemInput {
  supplier_invoice_id: string
  amount?: number
  payment_date?: string
}

export interface CreateBatchInput {
  format: 'pain001'
  items: CreateBatchItemInput[]
  confirm_already_batched?: boolean
}

export type CreateBatchResult =
  | { ok: true; batch: SupplierPaymentBatch }
  | { ok: false; code: 'debtor_incomplete'; missing: 'iban' | 'bic' | 'org_number' }
  | { ok: false; code: 'ineligible'; details: Array<{ id: string; reason: string }> }
  | { ok: false; code: 'amount_exceeds_remaining'; details: Array<{ id: string }> }
  | { ok: false; code: 'invalid_amount'; details: Array<{ id: string }> }
  | { ok: false; code: 'already_batched'; details: Array<{ id: string; batch_id: string }> }
  | { ok: false; code: 'create_failed' }

/** Shape returned by the create_supplier_payment_batch RPC. */
type CreateBatchRpcResult =
  | { ok: true; batch: SupplierPaymentBatch }
  | { ok: false; code: string; details?: unknown }

export async function createSupplierPaymentBatch(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  const today = getSwedishLocalDate()
  const ids = input.items.map((item) => item.supplier_invoice_id)

  const debtorResolution = await resolveBatchDebtor(supabase, companyId)
  if (!debtorResolution.ok) {
    return { ok: false, code: 'debtor_incomplete', missing: debtorResolution.missing }
  }
  const { debtor } = debtorResolution

  const [{ data: invoices }, activeBatchIdByInvoice] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select(INVOICE_SELECT)
      .eq('company_id', companyId)
      .in('id', ids),
    loadActiveBatchMap(supabase, companyId),
  ])
  const rows = (invoices ?? []) as unknown as InvoiceRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))

  const ineligible: Array<{ id: string; reason: string }> = []
  const excessive: Array<{ id: string }> = []
  const invalidAmount: Array<{ id: string }> = []
  const alreadyBatched: Array<{ id: string; batch_id: string }> = []
  const itemRows: Array<Omit<SupplierPaymentBatchItem, 'id' | 'batch_id' | 'created_at'>> = []

  for (const item of input.items) {
    const invoice = byId.get(item.supplier_invoice_id)
    if (!invoice || !invoice.supplier) {
      ineligible.push({ id: item.supplier_invoice_id, reason: invoice ? 'payee_missing' : 'not_found' })
      continue
    }
    const evaluation = evaluateInvoiceForBatch(invoice, invoice.supplier, {
      today,
      activeBatchIdByInvoice,
    })
    if (!evaluation.eligible) {
      ineligible.push({ id: invoice.id, reason: evaluation.reason })
      continue
    }
    if (evaluation.activeBatchId && !input.confirm_already_batched) {
      alreadyBatched.push({ id: invoice.id, batch_id: evaluation.activeBatchId })
      continue
    }

    const amount = item.amount !== undefined ? roundOre(item.amount) : evaluation.defaults.amount
    if (amount <= 0) {
      invalidAmount.push({ id: invoice.id })
      continue
    }
    if (amount > invoice.remaining_amount + ORE_TOLERANCE) {
      excessive.push({ id: invoice.id })
      continue
    }

    // A payment date in the past is normalized to today: banks reject passed
    // execution dates, and "pay now" is what an overdue due date means.
    const requestedDate = item.payment_date ?? evaluation.defaults.payment_date
    const paymentDate = requestedDate > today ? requestedDate : today

    const { payee } = evaluation
    itemRows.push({
      company_id: companyId,
      supplier_invoice_id: invoice.id,
      amount,
      payment_date: paymentDate,
      payee_type: payee.type,
      payee_bankgiro: payee.type === 'bankgiro' ? payee.bankgiro : null,
      payee_plusgiro: payee.type === 'plusgiro' ? payee.plusgiro : null,
      payee_clearing: payee.type === 'bank_account' ? payee.clearing : null,
      payee_account: payee.type === 'bank_account' ? payee.account : null,
      payee_name: invoice.supplier.name,
      payee_city: invoice.supplier.city?.trim() || null,
      reference_type: evaluation.reference.type,
      reference: evaluation.reference.value,
    })
  }

  if (ineligible.length > 0) return { ok: false, code: 'ineligible', details: ineligible }
  if (invalidAmount.length > 0) return { ok: false, code: 'invalid_amount', details: invalidAmount }
  if (excessive.length > 0) return { ok: false, code: 'amount_exceeds_remaining', details: excessive }
  if (alreadyBatched.length > 0) return { ok: false, code: 'already_batched', details: alreadyBatched }
  if (itemRows.length === 0) return { ok: false, code: 'create_failed' }

  // The id is minted here (not by the DB default) because msg_id derives from
  // it and both must land in the same transaction.
  const batchId = crypto.randomUUID()
  const orgDigits = debtor.org_number.replace(/\D/g, '')
  const msgId = `${getBranding().appName.toUpperCase()}-${orgDigits}-B${batchId.replace(/-/g, '').slice(0, 8).toUpperCase()}`.slice(0, 35)

  // The RPC is the authority: it locks the invoices, re-runs the active-batch
  // check inside the transaction (the loadActiveBatchMap pass above is the
  // friendly fast path, not the guarantee), and writes header + items
  // atomically. company_id rides in p_company_id, so it is stripped from the
  // item rows. Domain refusals come back as { ok: false, code }; constraint
  // violations and the tenant guard surface as an error.
  const { data, error } = await supabase.rpc('create_supplier_payment_batch', {
    p_company_id: companyId,
    p_batch_id: batchId,
    p_format: input.format,
    p_msg_id: msgId,
    p_debtor_snapshot: debtor,
    p_items: itemRows.map(({ company_id: _companyId, ...row }) => row),
    p_confirm_already_batched: input.confirm_already_batched ?? false,
    p_user_id: userId,
  })
  // The client only ever sees create_failed. The raw error (SQLSTATE, message,
  // details, hint) is what tells the RPC's tenant guard (42501), a constraint
  // violation inside the SECURITY DEFINER body and a PostgREST schema-cache
  // miss right after a deploy (PGRST202) apart, so it goes to the log (#2060).
  // Deliberately NOT logged: debtor_snapshot and the item rows (IBAN and payee
  // data); companyId, batchId and the item count make the line greppable. The
  // three text fields go through boundedRedactedText first, since Postgres
  // quotes the failing row in details; only the SQLSTATE is verbatim.
  if (error) {
    log.error('create_supplier_payment_batch RPC failed', {
      companyId,
      batchId,
      itemCount: itemRows.length,
      rpcError: {
        code: error.code,
        message: boundedRedactedText(error.message),
        details: boundedRedactedText(error.details),
        hint: boundedRedactedText(error.hint),
      },
    })
    return { ok: false, code: 'create_failed' }
  }

  const result = data as CreateBatchRpcResult | null
  if (!result) {
    log.error('create_supplier_payment_batch RPC returned no payload', {
      companyId,
      batchId,
      itemCount: itemRows.length,
    })
    return { ok: false, code: 'create_failed' }
  }
  if (!result.ok) {
    switch (result.code) {
      case 'already_batched':
        return {
          ok: false,
          code: 'already_batched',
          details: result.details as Array<{ id: string; batch_id: string }>,
        }
      case 'amount_exceeds_remaining':
        return {
          ok: false,
          code: 'amount_exceeds_remaining',
          details: result.details as Array<{ id: string }>,
        }
      case 'ineligible':
        return {
          ok: false,
          code: 'ineligible',
          details: result.details as Array<{ id: string; reason: string }>,
        }
      default:
        // An RPC refusal code with no client mapping (a code added in SQL
        // without this switch learning it, or the RPC's own payload-shape
        // refusals) must stay visible rather than vanish behind create_failed.
        log.error('create_supplier_payment_batch RPC refused with an unmapped code', {
          companyId,
          batchId,
          itemCount: itemRows.length,
          rpcCode: result.code,
          rpcDetails: result.details,
        })
        return { ok: false, code: 'create_failed' }
    }
  }

  return { ok: true, batch: result.batch }
}

export interface RenderedBatchFile {
  content: string
  contentType: string
  filename: string
}

/**
 * Render the payment file for a stored batch. Deterministic: same rows, same
 * bytes, on every call.
 */
export function renderSupplierPaymentBatchFile(
  batch: Pick<SupplierPaymentBatch, 'id' | 'format' | 'msg_id' | 'debtor_snapshot' | 'created_at'>,
  items: SupplierPaymentBatchItem[],
): RenderedBatchFile {
  if (batch.format !== 'pain001') {
    throw new Error(`Filformatet stöds inte: ${batch.format}`)
  }

  const payments: SupplierPain001Payment[] = items.map((item) => ({
    payee:
      item.payee_type === 'bankgiro'
        ? { type: 'bankgiro', bankgiro: item.payee_bankgiro ?? '' }
        : item.payee_type === 'plusgiro'
          ? { type: 'plusgiro', plusgiro: item.payee_plusgiro ?? '' }
          : {
              type: 'bank_account',
              clearing: item.payee_clearing ?? '',
              account: item.payee_account ?? '',
            },
    payeeName: item.payee_name,
    payeeCity: item.payee_city ?? null,
    amount: item.amount,
    paymentDate: item.payment_date,
    reference: { type: item.reference_type, value: item.reference },
  }))

  const debtor = batch.debtor_snapshot
  const content = generateSupplierPain001(
    {
      name: debtor.name,
      orgNumber: debtor.org_number,
      iban: debtor.iban,
      bic: debtor.bic,
      bankgiro: debtor.bankgiro ?? null,
      city: debtor.city ?? null,
    },
    payments,
    { messageId: batch.msg_id, createdAt: batch.created_at },
  )

  const datePart = batch.created_at.slice(0, 10).replace(/-/g, '')
  const shortId = batch.id.replace(/-/g, '').slice(0, 8)
  return {
    content,
    contentType: 'application/xml; charset=utf-8',
    filename: `betalfil_${datePart}_${shortId}.xml`,
  }
}
