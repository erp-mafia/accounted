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
 *
 * The file takes the form the paying bank accepts: ISO 20022 pain.001, or
 * Bankgirot's LB file for a bank that takes no pain.001 (Svea Bank,
 * crm#1424). The company's bank decides it, never the caller.
 */

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { getBranding } from '@/lib/branding/service'
import { ORE_TOLERANCE, roundOre, sumOre } from '@/lib/money'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { effectiveOrgNumber } from '@/lib/company/org-number'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { SVEA_BANK_BICS } from '@/lib/payments/bank-account'
import { payingAccountSummary, resolvePayingAccount, type PayingAccountSummary } from './paying-account'
import {
  evaluateInvoiceForBatch,
  type BatchExclusionReason,
  type BatchInvoiceFacts,
  type BatchItemWarning,
} from './batch-eligibility'
import { formatPayeeLabel, type SupplierPayee, type SupplierPayeeSource } from './supplier-payee'
import { holdFor, loadPayeeHolds, type PayeeAlertState } from './payee-alerts'
import type { StatedPayeeSource } from './payee-change'
import { isOpenPaymentOrder, OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from './orders/status'
import { generateSupplierPain001, type SupplierPain001Debtor, type SupplierPain001Payment } from './pain001-supplier'
import { resolveBankFileIds } from './initiating-party'
import { swedbankIso2PaysPayee } from './swedbank'
import { PAYMENT_ATTEST_GATE } from '@/lib/composition/payment-attest-gate'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { generateSupplierBgLb, type BgLbSupplierPayment } from './bg-lb'
import type {
  SupplierPaymentBatch,
  SupplierPaymentBatchDebtor,
  SupplierPaymentBatchFormat,
  SupplierPaymentBatchItem,
} from '@/types'

const log = createLogger('payments/batch-service')

type InvoiceRow = BatchInvoiceFacts &
  StatedPayeeSource & {
    supplier_id: string
    supplier: (SupplierPayeeSource & { id: string; name: string; city: string | null; iban: string | null }) | null
  }

const INVOICE_SELECT =
  'id, supplier_id, status, approved_at, due_date, remaining_amount, currency, is_credit_note, auto_debit, ' +
  'payment_reference, supplier_invoice_number, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban, ' +
  'supplier:suppliers(id, name, city, bankgiro, plusgiro, bank_account, clearing_number, account_number, iban)'

/**
 * What holds each invoice back on the account it states (lib/payments/
 * payee-alerts.ts): the same derivation the bank payment preparation uses, so
 * the file and the bank refuse the same invoices.
 */
function loadBatchPayeeHolds(
  supabase: SupabaseClient,
  companyId: string,
  rows: InvoiceRow[],
): Promise<Map<string, PayeeAlertState>> {
  const cards = new Map(rows.flatMap((row) => (row.supplier ? [[row.supplier_id, row.supplier] as const] : [])))
  return loadPayeeHolds(supabase, companyId, rows, cards)
}

export interface BatchDebtor {
  name: string
  org_number: string
  iban: string
  bic: string
  /** Company bankgiro digits; a debit account only where the debtor's bank takes one, and the sender of an LB file. */
  bankgiro: string | null
  /** Company town; Dbtr/PstlAdr/TwnNm (mandatory from Nov 2026 when present). */
  city: string | null
  /**
   * Swedbank's SignerID and Corporate Pay agreement id: set for a Swedbank
   * debtor only, and then always both (lib/payments/swedbank.ts). Absent for
   * every other bank, so their snapshots keep their shape.
   */
  swedbank_signer_id?: string
  swedbank_corporate_pay_id?: string
  /** Nordea's Signer ID: set for a Nordea debtor only (lib/payments/nordea.ts). */
  nordea_signer_id?: string
}

/**
 * The company setting a payment file cannot be made without. iban and bic:
 * the paying account (lib/payments/paying-account.ts) has no IBAN, or its
 * bank cannot be named. swedbank_ids: the debtor's bank is Swedbank and its
 * SignerID or Corporate Pay agreement id is missing; nordea_signer_id: the
 * debtor's bank is Nordea and its Signer ID is missing. Both banks refuse a
 * file without them at upload (lib/payments/initiating-party.ts).
 */
export type DebtorMissing = 'iban' | 'bic' | 'org_number' | 'swedbank_ids' | 'nordea_signer_id'

/** A refused debtor: what is missing and, for iban and bic, the paying account that lacks it. */
export interface DebtorRefusal {
  ok: false
  missing: DebtorMissing
  account?: PayingAccountSummary
}

export type DebtorResolution = { ok: true; debtor: BatchDebtor } | DebtorRefusal

/**
 * What a supplier payment file cannot be made without: the debtor settings,
 * or bankgiro: the debtor's bank takes only an LB file, which is sent from
 * the company's bankgiro number.
 */
export type FileDebtorMissing = DebtorMissing | 'bankgiro'

/** The debtor of a supplier payment file and the form its bank takes (resolveFileDebtor). */
export type FileDebtorResolution =
  | { ok: true; debtor: BatchDebtor; format: SupplierPaymentBatchFormat }
  | (Omit<DebtorRefusal, 'missing'> & { missing: FileDebtorMissing })

/**
 * Banks, by 8-character BIC, whose file upload takes Bankgirot's LB file and
 * no pain.001. Svea Bank answers a pain.001 upload with "Content is neither
 * BgLon or LbFile" (crm#1424).
 */
const LB_FILE_BICS: ReadonlySet<string> = SVEA_BANK_BICS

/** The file form the debtor's bank takes. */
export function batchFileFormat(bic: string): SupplierPaymentBatchFormat {
  return LB_FILE_BICS.has(bic.replace(/\s/g, '').toUpperCase().slice(0, 8)) ? 'bg_lb' : 'pain001'
}

/** The form a file for this debtor takes, also when its resolution stopped at the bankgiro an LB file needs. */
export function resolutionFormat(resolution: FileDebtorResolution): SupplierPaymentBatchFormat {
  if (resolution.ok) return resolution.format
  return resolution.missing === 'bankgiro' ? 'bg_lb' : 'pain001'
}

/**
 * Whether a new file for this debtor takes Swedbank's ISO 2.0 form: a
 * Swedbank debtor with both ids, or one that lacks them (it can get no other
 * form; resolveSwedbankFileIds). Such a file pays to bank accounts only
 * (swedbankIso2PaysPayee, crm#1156).
 */
export function paysThroughSwedbankIso2(resolution: DebtorResolution | FileDebtorResolution): boolean {
  if (!resolution.ok) return resolution.missing === 'swedbank_ids'
  return Boolean(resolution.debtor.swedbank_signer_id && resolution.debtor.swedbank_corporate_pay_id)
}

/** Why an invoice is left out because the debtor's Swedbank ISO 2.0 agreement does not pay to its payee. */
export const SWEDBANK_ISO2_GIRO_PAYEE = 'swedbank_iso2_giro_payee' as const

/**
 * Why an invoice is left out of an LB file: it pays to a bank account, which
 * an LB file reaches only through an utbetalningsnummer kept per supplier
 * (TK40), not built here. Every batch line so far paid a bankgiro or
 * PlusGiro number.
 */
export const LB_BANK_ACCOUNT_PAYEE = 'lb_bank_account_payee' as const

/** Why the file this debtor's bank takes cannot carry the payee, or null when it can. */
function payeeOutsideFile(
  resolution: FileDebtorResolution,
  payeeType: SupplierPayee['type'],
): typeof SWEDBANK_ISO2_GIRO_PAYEE | typeof LB_BANK_ACCOUNT_PAYEE | null {
  if (paysThroughSwedbankIso2(resolution) && !swedbankIso2PaysPayee(payeeType)) return SWEDBANK_ISO2_GIRO_PAYEE
  if (resolutionFormat(resolution) === 'bg_lb' && payeeType === 'bank_account') return LB_BANK_ACCOUNT_PAYEE
  return null
}

/**
 * Resolve the paying company (pain.001 debtor). The account is the one the
 * salary file pays from too (lib/payments/paying-account.ts): the primary
 * bank account, with its IBAN and a BIC saved or derived, never the
 * customer-invoice IBAN (crm#1483). The org number is required: InitgPty
 * must carry an OrgId (Swedbank Validex PFH_002). The bankgiro rides along
 * when valid so bankgiro payees can be debited BGNR-to-BGNR where the
 * debtor's bank takes that. A Swedbank or Nordea debtor also needs the ids
 * its bank assigns (initiating-party.ts); without them no file is made,
 * because the bank would refuse it.
 */
export async function resolveBatchDebtor(
  supabase: SupabaseClient,
  companyId: string,
): Promise<DebtorResolution> {
  const [{ data: company }, { data: settings }] = await Promise.all([
    supabase.from('companies').select('name, org_number').eq('id', companyId).single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, city, iban, bic, bankgiro, swedbank_signer_id, swedbank_corporate_pay_id, nordea_signer_id')
      .eq('company_id', companyId)
      .single(),
  ])

  const paying = await resolvePayingAccount(supabase, companyId, log, { settings: settings ?? null })
  if (!paying.ok) return { ok: false, missing: paying.missing, account: payingAccountSummary(paying.account) }
  const { iban, bic } = paying.account

  const orgNumber = orgNumberKey(effectiveOrgNumber(settings?.org_number, company?.org_number))
  if (!orgNumber) return { ok: false, missing: 'org_number' }

  const fileIds = resolveBankFileIds(bic, settings)
  if (!fileIds.ok) return { ok: false, missing: fileIds.missing }
  const { swedbank, nordeaSignerId } = fileIds.ids

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
      ...(swedbank
        ? {
            swedbank_signer_id: swedbank.signerId,
            swedbank_corporate_pay_id: swedbank.corporatePayId,
          }
        : {}),
      ...(nordeaSignerId ? { nordea_signer_id: nordeaSignerId } : {}),
    },
  }
}

/**
 * The debtor of a supplier payment file and the form its bank takes. An LB
 * file is sent from the company's bankgiro, so a debtor whose bank takes
 * only that file has no file without one. The tax payment file reads
 * resolveBatchDebtor alone: its form is the person's choice.
 */
export async function resolveFileDebtor(supabase: SupabaseClient, companyId: string): Promise<FileDebtorResolution> {
  const resolution = await resolveBatchDebtor(supabase, companyId)
  if (!resolution.ok) return resolution
  const format = batchFileFormat(resolution.debtor.bic)
  if (format === 'bg_lb' && !resolution.debtor.bankgiro) return { ok: false, missing: 'bankgiro' }
  return { ...resolution, format }
}

/**
 * Whether the company attests supplier invoices at all (the attest gate:
 * kontantmetoden has no attest step, crm#1141). Asked only when one of the
 * rows lacks attest: for attested rows the answer changes nothing, since it
 * decides only the unattested warning (batch-eligibility.ts).
 */
async function companyAttestsFor(
  supabase: SupabaseClient,
  companyId: string,
  rows: ReadonlyArray<{ approved_at: string | null }>,
): Promise<boolean> {
  if (!rows.some((row) => !row.approved_at)) return true
  return PAYMENT_ATTEST_GATE.attestsSupplierInvoices(supabase, companyId)
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

/**
 * Invoices a bank payment order still covers (lib/payments/orders): a file
 * must not pay them too. The database refuses such an item as well
 * (refuse_batch_item_for_invoice_in_payment); reading it here turns that into
 * a named exclusion instead of a failed create. Fails closed, like
 * loadActiveBatchMap.
 */
export async function loadInvoicesInBankPayment(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: string[],
): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from('payment_orders')
    .select('supplier_invoice_id, status, supplier_invoice_payment_id')
    .eq('company_id', companyId)
    .in('supplier_invoice_id', invoiceIds)
    .in('status', OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES)
  if (error) throw error
  return new Set(
    ((data ?? []) as Array<{ supplier_invoice_id: string; status: string; supplier_invoice_payment_id: string | null }>)
      .filter((order) => isOpenPaymentOrder(order))
      .map((order) => order.supplier_invoice_id),
  )
}

export interface BatchPreviewLine {
  id: string
  supplier_name: string
  /** NULL for an invoice without the supplier's number; it then pays by its OCR. */
  invoice_number: string | null
  amount: number
  payment_date: string
  payee: { type: string; label: string }
  reference: { type: 'ocr' | 'invoice_number'; value: string }
  warnings: BatchItemWarning[]
  active_batch_id: string | null
}

export interface BatchPreview {
  /** The file form the company's bank takes (batchFileFormat). */
  format: SupplierPaymentBatchFormat
  eligible: BatchPreviewLine[]
  excluded: Array<{
    id: string
    reason: BatchExclusionReason | 'not_found' | 'in_bank_payment' | typeof SWEDBANK_ISO2_GIRO_PAYEE | typeof LB_BANK_ACCOUNT_PAYEE
  }>
  total: number
  debtor_ok: boolean
  debtor_missing?: FileDebtorMissing
  /** The paying account that lacks the IBAN or BIC (debtor_missing iban or bic). */
  debtor_account?: PayingAccountSummary
}

export async function previewSupplierPaymentBatch(
  supabase: SupabaseClient,
  companyId: string,
  input: { ids: string[] },
): Promise<BatchPreview> {
  // Swedish calendar date, not UTC: between 00:00 and 01:59 Swedish summer
  // time a UTC slice is still yesterday, and "pay today" would produce an
  // execution date the bank rejects as passed.
  const today = todayIsoStockholm()

  const [{ data: invoices }, activeBatchIdByInvoice, debtorResolution, inBankPayment, attestBlocked] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select(INVOICE_SELECT)
      .eq('company_id', companyId)
      .in('id', input.ids),
    loadActiveBatchMap(supabase, companyId),
    resolveFileDebtor(supabase, companyId),
    loadInvoicesInBankPayment(supabase, companyId, input.ids),
    PAYMENT_ATTEST_GATE.blockedInvoiceIds(supabase, companyId, input.ids),
  ])

  const rows = (invoices ?? []) as unknown as InvoiceRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const [payeeHolds, companyAttests] = await Promise.all([
    loadBatchPayeeHolds(supabase, companyId, rows),
    companyAttestsFor(supabase, companyId, rows),
  ])

  const eligible: BatchPreviewLine[] = []
  const excluded: BatchPreview['excluded'] = []

  for (const id of input.ids) {
    const invoice = byId.get(id)
    if (!invoice || !invoice.supplier) {
      excluded.push({ id, reason: invoice ? 'payee_missing' : 'not_found' })
      continue
    }
    if (inBankPayment.has(id)) {
      excluded.push({ id, reason: 'in_bank_payment' })
      continue
    }
    const evaluation = evaluateInvoiceForBatch({ ...invoice, payee_hold: holdFor(payeeHolds, id) }, invoice.supplier, {
      today,
      activeBatchIdByInvoice,
      attestBlocked,
      companyAttests,
    })
    if (!evaluation.eligible) {
      excluded.push({ id, reason: evaluation.reason })
      continue
    }
    // Left out, not refused: the payees the bank's file form carries still make a file.
    const outside = payeeOutsideFile(debtorResolution, evaluation.payee.type)
    if (outside) {
      excluded.push({ id, reason: outside })
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
    format: resolutionFormat(debtorResolution),
    eligible,
    excluded,
    total,
    debtor_ok: debtorResolution.ok,
    ...(debtorResolution.ok
      ? {}
      : {
          debtor_missing: debtorResolution.missing,
          ...(debtorResolution.account ? { debtor_account: debtorResolution.account } : {}),
        }),
  }
}

export interface CreateBatchItemInput {
  supplier_invoice_id: string
  amount?: number
  payment_date?: string
}

/**
 * What a line was expected to pay, pinned when a create was staged for
 * approval (MCP) or copied from a dry run (v1). The payee is a fingerprint,
 * never the account itself: a Swedish personkonto number IS the owner's
 * personnummer, and staged params are stored and shown verbatim.
 */
export interface ExpectedBatchPayee {
  supplier_invoice_id: string
  payee_fingerprint: string
  amount: number
}

export interface CreateBatchInput {
  items: CreateBatchItemInput[]
  confirm_already_batched?: boolean
  /**
   * When present, every line with a pin must still pay the same payee and
   * amount, or the whole create is refused (payee_changed). The dashboard
   * never sends it: its preview and create are seconds apart.
   */
  expected_payees?: ExpectedBatchPayee[]
}

/**
 * Exact identity of a payee as a lowercase hex SHA-256 over its type and
 * canonical digits. Equal fingerprints mean the same bankgiro, plusgiro or
 * clearing + account number; any edit to the supplier's payment details
 * changes it.
 */
export function payeeFingerprint(payee: SupplierPayee): string {
  const canonical =
    payee.type === 'bankgiro'
      ? `bankgiro:${payee.bankgiro}`
      : payee.type === 'plusgiro'
        ? `plusgiro:${payee.plusgiro}`
        : `bank_account:${payee.clearing}:${payee.account}`
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type CreateBatchResult =
  | { ok: true; batch: SupplierPaymentBatch }
  | { ok: false; code: 'debtor_incomplete'; missing: FileDebtorMissing; account?: PayingAccountSummary }
  | { ok: false; code: 'ineligible'; details: Array<{ id: string; reason: string }> }
  | { ok: false; code: 'amount_exceeds_remaining'; details: Array<{ id: string }> }
  | { ok: false; code: 'invalid_amount'; details: Array<{ id: string }> }
  | { ok: false; code: 'already_batched'; details: Array<{ id: string; batch_id: string }> }
  | {
      ok: false
      code: 'payee_changed'
      details: Array<{ id: string; supplier_name: string; changed: Array<'payee' | 'amount'> }>
    }
  | { ok: false; code: 'create_failed' }

/** Shape returned by the create_supplier_payment_batch RPC. */
type CreateBatchRpcResult =
  | { ok: true; batch: SupplierPaymentBatch }
  | { ok: false; code: string; details?: unknown }

/** One planned batch line: the item row to insert plus the warnings the preview showed for it. */
export type PlannedBatchItem = Omit<SupplierPaymentBatchItem, 'id' | 'batch_id' | 'created_at'>

export interface SupplierPaymentBatchPlan {
  /** The file form the company's bank takes. */
  format: SupplierPaymentBatchFormat
  debtor: BatchDebtor
  items: PlannedBatchItem[]
  /** Parallel to items: the non-blocking warnings each line carries. */
  warnings: BatchItemWarning[][]
  total_amount: number
}

export type PlanBatchResult =
  | { ok: true; plan: SupplierPaymentBatchPlan }
  | Exclude<CreateBatchResult, { ok: true }>

/**
 * Everything create checks, and nothing it writes: resolve the debtor,
 * re-read and re-evaluate every invoice, and build the item rows. Reads
 * only, so it is also the dry run (an MCP stage, ?dry_run=true); no batch id
 * or MsgId is minted here.
 */
export async function planSupplierPaymentBatch(
  supabase: SupabaseClient,
  companyId: string,
  input: CreateBatchInput,
): Promise<PlanBatchResult> {
  const today = todayIsoStockholm()
  const ids = input.items.map((item) => item.supplier_invoice_id)

  const debtorResolution = await resolveFileDebtor(supabase, companyId)
  if (!debtorResolution.ok) {
    return {
      ok: false,
      code: 'debtor_incomplete',
      missing: debtorResolution.missing,
      ...(debtorResolution.account ? { account: debtorResolution.account } : {}),
    }
  }
  const { debtor, format } = debtorResolution

  const [{ data: invoices }, activeBatchIdByInvoice, inBankPayment, attestBlocked] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select(INVOICE_SELECT)
      .eq('company_id', companyId)
      .in('id', ids),
    loadActiveBatchMap(supabase, companyId),
    loadInvoicesInBankPayment(supabase, companyId, ids),
    PAYMENT_ATTEST_GATE.blockedInvoiceIds(supabase, companyId, ids),
  ])
  const rows = (invoices ?? []) as unknown as InvoiceRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const [payeeHolds, companyAttests] = await Promise.all([
    loadBatchPayeeHolds(supabase, companyId, rows),
    companyAttestsFor(supabase, companyId, rows),
  ])

  const ineligible: Array<{ id: string; reason: string }> = []
  const excessive: Array<{ id: string }> = []
  const invalidAmount: Array<{ id: string }> = []
  const alreadyBatched: Array<{ id: string; batch_id: string }> = []
  const payeeChanged: Array<{ id: string; supplier_name: string; changed: Array<'payee' | 'amount'> }> = []
  const pins = new Map((input.expected_payees ?? []).map((pin) => [pin.supplier_invoice_id, pin]))
  const itemRows: PlannedBatchItem[] = []
  const itemWarnings: BatchItemWarning[][] = []

  for (const item of input.items) {
    const invoice = byId.get(item.supplier_invoice_id)
    if (!invoice || !invoice.supplier) {
      ineligible.push({ id: item.supplier_invoice_id, reason: invoice ? 'payee_missing' : 'not_found' })
      continue
    }
    if (inBankPayment.has(invoice.id)) {
      ineligible.push({ id: invoice.id, reason: 'in_bank_payment' })
      continue
    }
    const evaluation = evaluateInvoiceForBatch({ ...invoice, payee_hold: holdFor(payeeHolds, invoice.id) }, invoice.supplier, {
      today,
      activeBatchIdByInvoice,
      attestBlocked,
      companyAttests,
    })
    if (!evaluation.eligible) {
      ineligible.push({ id: invoice.id, reason: evaluation.reason })
      continue
    }
    // Swedbank refuses a bankgiro or plusgiro payee in an ISO 2.0 file
    // (crm#1156), and an LB file here pays no bank account; the preview
    // leaves such a line out, a create naming it is refused like any other
    // ineligible line.
    const outside = payeeOutsideFile(debtorResolution, evaluation.payee.type)
    if (outside) {
      ineligible.push({ id: invoice.id, reason: outside })
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

    // A line staged for approval pays exactly what the approver saw: a
    // supplier whose payment details (or remaining amount) changed since
    // is refused, never silently paid to the new account.
    const pin = pins.get(invoice.id)
    if (pin) {
      const changed: Array<'payee' | 'amount'> = []
      if (pin.payee_fingerprint !== payeeFingerprint(payee)) changed.push('payee')
      if (Math.abs(roundOre(pin.amount) - amount) > ORE_TOLERANCE) changed.push('amount')
      if (changed.length > 0) {
        payeeChanged.push({ id: invoice.id, supplier_name: invoice.supplier.name, changed })
        continue
      }
    }

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
    itemWarnings.push(evaluation.warnings)
  }

  if (ineligible.length > 0) return { ok: false, code: 'ineligible', details: ineligible }
  if (invalidAmount.length > 0) return { ok: false, code: 'invalid_amount', details: invalidAmount }
  if (excessive.length > 0) return { ok: false, code: 'amount_exceeds_remaining', details: excessive }
  if (payeeChanged.length > 0) return { ok: false, code: 'payee_changed', details: payeeChanged }
  if (alreadyBatched.length > 0) return { ok: false, code: 'already_batched', details: alreadyBatched }
  if (itemRows.length === 0) return { ok: false, code: 'create_failed' }

  return {
    ok: true,
    plan: {
      format,
      debtor,
      items: itemRows,
      warnings: itemWarnings,
      total_amount: sumOre(itemRows.map((row) => row.amount)),
    },
  }
}

export async function createSupplierPaymentBatch(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  const planned = await planSupplierPaymentBatch(supabase, companyId, input)
  if (!planned.ok) return planned
  const { format, debtor, items: itemRows } = planned.plan

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
    p_format: format,
    p_msg_id: msgId,
    p_debtor_snapshot: debtor,
    p_items: itemRows.map(({ company_id: _companyId, ...row }) => row),
    p_confirm_already_batched: input.confirm_already_batched ?? false,
    p_user_id: userId,
  })
  // The client only ever sees create_failed. What tells the RPC's tenant
  // guard (42501), a constraint violation inside the SECURITY DEFINER body
  // and a PostgREST schema-cache miss right after a deploy (PGRST202) apart
  // is the SQLSTATE plus the message (the RPC's own RAISE text, "violates
  // check constraint <name>", "duplicate key value violates unique
  // constraint <name>"), so those two go to the log (#2060). `details` is
  // where Postgres quotes row data ("Failing row contains (...)",
  // "Key (...)=(...)") and `hint` adds nothing operational: neither is
  // logged, so payee and account data cannot reach a log line through them.
  // debtor_snapshot and the item rows are not logged either; companyId,
  // batchId and the item count make the line greppable.
  if (error) {
    log.error('create_supplier_payment_batch RPC failed', {
      companyId,
      batchId,
      itemCount: itemRows.length,
      rpcError: { code: error.code, message: error.message },
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
  /** How `content` is written to bytes for the bank: UTF-8 for pain.001, ISO 8859-1 for an LB file. */
  charset: 'utf-8' | 'iso-8859-1'
}

/** The file's bytes as the bank takes them. */
export function batchFileBytes(file: Pick<RenderedBatchFile, 'content' | 'charset'>): Buffer<ArrayBuffer> {
  return Buffer.from(file.content, file.charset === 'iso-8859-1' ? 'latin1' : 'utf8')
}

/**
 * Render the payment file for a stored batch. Deterministic: same rows, same
 * bytes, on every call.
 */
export function renderSupplierPaymentBatchFile(
  batch: Pick<SupplierPaymentBatch, 'id' | 'format' | 'msg_id' | 'debtor_snapshot' | 'created_at'>,
  items: SupplierPaymentBatchItem[],
): RenderedBatchFile {
  if (batch.format === 'bg_lb') return renderBgLbFile(batch, items)
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

  const content = generateSupplierPain001(supplierPain001Debtor(batch.debtor_snapshot), payments, {
    messageId: batch.msg_id,
    createdAt: batch.created_at,
  })

  return {
    content,
    contentType: 'application/xml; charset=utf-8',
    filename: supplierPaymentBatchFilename(batch),
    charset: 'utf-8',
  }
}

/**
 * The pain.001 debtor of a resolved debtor or a stored snapshot, for the
 * batch file and the tax payment file alike, so a bank-assigned id stored in
 * the snapshot always reaches the file. Only a Swedbank batch made since
 * 2026-10-11 has both Swedbank ids, and only a Nordea batch made since
 * crm#1530 the Signer ID; an older snapshot regenerates exactly as it was
 * first downloaded.
 */
export function supplierPain001Debtor(debtor: SupplierPaymentBatchDebtor): SupplierPain001Debtor {
  return {
    name: debtor.name,
    orgNumber: debtor.org_number,
    iban: debtor.iban,
    bic: debtor.bic,
    bankgiro: debtor.bankgiro ?? null,
    city: debtor.city ?? null,
    swedbank:
      debtor.swedbank_signer_id && debtor.swedbank_corporate_pay_id
        ? { signerId: debtor.swedbank_signer_id, corporatePayId: debtor.swedbank_corporate_pay_id }
        : null,
    nordeaSignerId: debtor.nordea_signer_id || null,
  }
}

/**
 * The LB file of a stored batch: one TK14 or TK54 per line, sent from the
 * company's bankgiro. Written the day the batch was created (Swedish
 * calendar day), so every download is byte-identical.
 */
function renderBgLbFile(
  batch: Pick<SupplierPaymentBatch, 'id' | 'format' | 'debtor_snapshot' | 'created_at'>,
  items: SupplierPaymentBatchItem[],
): RenderedBatchFile {
  const sender = batch.debtor_snapshot.bankgiro
  if (!sender) throw new Error('LB-filen saknar avsändarens bankgironummer')
  const payments: BgLbSupplierPayment[] = items.map((item) => {
    if (item.payee_type === 'bank_account') throw new Error('LB-filen betalar inte till bankkonton')
    return {
      payee:
        item.payee_type === 'bankgiro'
          ? { type: 'bankgiro', bankgiro: item.payee_bankgiro ?? '' }
          : { type: 'plusgiro', plusgiro: item.payee_plusgiro ?? '' },
      reference: item.reference,
      amount: item.amount,
      paymentDate: item.payment_date,
      payeeName: item.payee_name,
    }
  })
  return {
    content: generateSupplierBgLb(sender, payments, { writeDate: todayIsoStockholm(new Date(batch.created_at)) }),
    contentType: 'text/plain; charset=iso-8859-1',
    filename: supplierPaymentBatchFilename(batch),
    charset: 'iso-8859-1',
  }
}

/** The download filename of a batch's file: betalfil_<yyyymmdd>_<first 8 of the id>, .xml for pain.001 and .txt for an LB file. */
export function supplierPaymentBatchFilename(batch: Pick<SupplierPaymentBatch, 'id' | 'created_at' | 'format'>): string {
  const datePart = batch.created_at.slice(0, 10).replace(/-/g, '')
  const shortId = batch.id.replace(/-/g, '').slice(0, 8)
  return `betalfil_${datePart}_${shortId}.${batch.format === 'bg_lb' ? 'txt' : 'xml'}`
}
