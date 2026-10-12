/**
 * Prepare bank payments for supplier invoices: one draft payment order per
 * invoice, from one of the company's own accounts.
 *
 * Eligibility, amount, default date and reference come from the same rules
 * the payment file uses (evaluateInvoiceForBatch), so the two channels never
 * disagree about what may be paid. The payee adds the invoice's own stated
 * account (resolveOrderPayee). Nothing reaches the bank here: a draft is
 * edited, approved by a person, and only then signed with BankID.
 *
 * create_payment_orders runs as the service role (a member's own session
 * cannot call it) and decides payee_check itself from the supplier card, the
 * invoice and the payments a person already approved; the warnings below are
 * read back from what it decided.
 */

import { randomUUID } from 'node:crypto'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { evaluateInvoiceForBatch, type BatchExclusionReason } from '@/lib/payments/batch-eligibility'
import { openPaymentsDoor } from './switched-on'
import { executionDateFor } from '@/lib/payments/bank-days'
import { formatPayeeLabel, type SupplierPayee } from '@/lib/payments/supplier-payee'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveDebtor } from './debtor'
import { resolveOrderPayee } from './payee'
import { isOpenPaymentOrder } from './status'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'

export interface PreparePaymentOrdersInput {
  supplierInvoiceIds: string[]
  cashAccountId: string
  /** YYYY-MM-DD. Defaults per invoice: the due date, or today when it has passed. */
  executionDate?: string | null
  /** Invoice ids where the person chose the account the invoice states over the supplier card. */
  useStatedPayeeFor?: string[]
  /** YYYY-MM-DD in Stockholm; injected so tests and the preview agree. */
  today: string
  /**
   * Run every check and answer the lines that would be created, without
   * calling create_payment_orders: the v1 dry run and the MCP staging preview.
   */
  dryRun?: boolean
}

export type PrepareSkipReason = BatchExclusionReason | 'not_found' | 'in_payment_file' | 'already_in_payment'

export interface PreparedOrderWarning {
  supplier_invoice_id: string
  code: 'unattested' | 'ocr_invalid' | 'payee_changed' | 'payee_new' | 'date_moved'
  /** For payee warnings: the other account, so the person can compare. */
  alternative_payee?: string | null
  /** For date_moved: the day asked for (no banking day, or too soon for the bank) and the banking day it became. */
  from?: string
  to?: string
}

export interface PreparePaymentOrdersResult {
  orders: PaymentOrderRow[]
  skipped: Array<{ supplier_invoice_id: string; reason: PrepareSkipReason }>
  warnings: PreparedOrderWarning[]
  /** Drafts of the same invoices that nobody approved, cancelled here so the person's latest choice wins. */
  replaced_draft_ids: string[]
}

interface InvoiceRow {
  id: string
  supplier_id: string
  status: string
  approved_at: string | null
  due_date: string
  remaining_amount: number
  currency: string
  is_credit_note: boolean
  payment_reference: string | null
  supplier_invoice_number: string
  payee_bankgiro: string | null
  payee_plusgiro: string | null
  payee_clearing: string | null
  payee_account: string | null
}

interface SupplierRow {
  id: string
  name: string
  bankgiro: string | null
  plusgiro: string | null
  bank_account: string | null
  clearing_number: string | null
  account_number: string | null
}

function payeeColumns(payee: SupplierPayee) {
  return {
    payee_type: payee.type,
    payee_bankgiro: payee.type === 'bankgiro' ? payee.bankgiro : null,
    payee_plusgiro: payee.type === 'plusgiro' ? payee.plusgiro : null,
    payee_clearing: payee.type === 'bank_account' ? payee.clearing : null,
    payee_account: payee.type === 'bank_account' ? payee.account : null,
  }
}

const RPC_CODES: Record<string, string> = {
  sandbox: 'PAYMENTS_UNAVAILABLE',
  ineligible: 'PAYMENT_ORDERS_INELIGIBLE',
  already_in_payment: 'PAYMENT_ORDERS_ALREADY_IN_PAYMENT',
  in_payment_file: 'PAYMENT_ORDERS_IN_PAYMENT_FILE',
  amount_exceeds_remaining: 'PAYMENT_ORDERS_AMOUNT_EXCEEDS_REMAINING',
  currency_mismatch: 'PAYMENT_ORDERS_CURRENCY_MISMATCH',
  payee_mismatch: 'PAYMENT_ORDERS_PAYEE_MISMATCH',
  idempotency_mismatch: 'PAYMENT_ORDERS_IDEMPOTENCY_MISMATCH',
  invalid_payload: 'VALIDATION_ERROR',
}

export async function preparePaymentOrders(
  ctx: OperationContext,
  input: PreparePaymentOrdersInput,
): Promise<OperationOutcome<PreparePaymentOrdersResult>> {
  const { supabase, companyId, userId, log } = ctx
  const ids = [...new Set(input.supplierInvoiceIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  // Never from the sandbox: a demo visitor must not reach a real bank, and the
  // sandbox teardown relies on no payment order ever existing there.
  if (await isSandboxCompany(supabase, companyId)) {
    return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'sandbox' } }
  }
  if (input.executionDate && input.executionDate < input.today) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'execution_date', reason: 'in_the_past' } }
  }

  const { data: account } = await supabase
    .from('cash_accounts')
    .select('id, iban, currency, name, enabled, bank_connection:bank_connections(bank_name, affiliated_aspsp_id, psu_type)')
    .eq('id', input.cashAccountId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!account) return { ok: false, code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE', details: { reason: 'not_found' } }
  const acct = account as unknown as {
    iban: string | null
    currency: string
    name: string | null
    enabled: boolean
    bank_connection: { bank_name: string | null; affiliated_aspsp_id: string | null; psu_type: string | null } | null
  }
  const debtor = resolveDebtor(acct, acct.bank_connection)
  if (!debtor.ok) return { ok: false, code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE', details: { reason: debtor.reason } }

  const { data: invoiceData, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .select(
      'id, supplier_id, status, approved_at, due_date, remaining_amount, currency, is_credit_note, payment_reference, supplier_invoice_number, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account',
    )
    .eq('company_id', companyId)
    .in('id', ids)
  if (invoiceError) throw invoiceError
  const invoices = (invoiceData ?? []) as InvoiceRow[]

  const supplierIds = [...new Set(invoices.map((i) => i.supplier_id))]
  const { data: supplierData, error: supplierError } = supplierIds.length
    ? await supabase
        .from('suppliers')
        .select('id, name, bankgiro, plusgiro, bank_account, clearing_number, account_number')
        .eq('company_id', companyId)
        .in('id', supplierIds)
    : { data: [], error: null }
  if (supplierError) throw supplierError
  const suppliers = new Map(((supplierData ?? []) as SupplierRow[]).map((s) => [s.id, s]))

  // Open file batches and open orders are refused by the database too; reading
  // them here turns a whole-call refusal into a per-invoice skip.
  const { data: batchItems } = await supabase
    .from('supplier_payment_batch_items')
    .select('supplier_invoice_id, batch:supplier_payment_batches!inner(status)')
    .eq('company_id', companyId)
    .in('supplier_invoice_id', ids)
  const inOpenFile = new Set(
    ((batchItems ?? []) as unknown as Array<{ supplier_invoice_id: string; batch: { status: string } | null }>)
      .filter((i) => i.batch?.status === 'created')
      .map((i) => i.supplier_invoice_id),
  )
  const { data: openOrders } = await supabase
    .from('payment_orders')
    .select('id, supplier_invoice_id, status, supplier_invoice_payment_id')
    .eq('company_id', companyId)
    .in('supplier_invoice_id', ids)
  const openRows = (openOrders ?? []) as Array<{ id: string; supplier_invoice_id: string; status: string; supplier_invoice_payment_id: string | null }>
  // An order the bank may have, or a person already approved, blocks the
  // invoice. A draft nobody approved does not: it is replaced below, so a
  // second Betala via banken never fails on the first one's leftovers.
  const inOpenOrder = new Set(openRows.filter((o) => o.status !== 'draft' && isOpenPaymentOrder(o)).map((o) => o.supplier_invoice_id))
  const staleDrafts = new Map<string, string[]>()
  for (const o of openRows) {
    if (o.status !== 'draft') continue
    staleDrafts.set(o.supplier_invoice_id, [...(staleDrafts.get(o.supplier_invoice_id) ?? []), o.id])
  }

  const useStated = new Set(input.useStatedPayeeFor ?? [])
  const skipped: PreparePaymentOrdersResult['skipped'] = []
  const warnings: PreparedOrderWarning[] = []
  const payloads: Record<string, unknown>[] = []
  /** What a dry run answers per line: the payee as a label, never the raw account columns. */
  const previewLines: Array<Record<string, unknown>> = []
  /** The other account per invoice when the card and the document disagree, for the warning text. */
  const alternatives = new Map<string, string | null>()
  const byId = new Map(invoices.map((i) => [i.id, i]))

  for (const id of ids) {
    const invoice = byId.get(id)
    const supplier = invoice ? suppliers.get(invoice.supplier_id) : undefined
    if (!invoice || !supplier) {
      skipped.push({ supplier_invoice_id: id, reason: 'not_found' })
      continue
    }
    if (inOpenFile.has(id) && invoice.status !== 'paid') {
      skipped.push({ supplier_invoice_id: id, reason: 'in_payment_file' })
      continue
    }
    if (inOpenOrder.has(id)) {
      skipped.push({ supplier_invoice_id: id, reason: 'already_in_payment' })
      continue
    }
    const evaluation = evaluateInvoiceForBatch(
      { ...invoice, remaining_amount: Number(invoice.remaining_amount) },
      supplier,
      { today: input.today },
    )
    if (!evaluation.eligible) {
      skipped.push({ supplier_invoice_id: id, reason: evaluation.reason })
      continue
    }
    const payee = resolveOrderPayee(invoice, supplier, { useStatedPayee: useStated.has(id) })
    if (!payee.ok) {
      skipped.push({ supplier_invoice_id: id, reason: payee.reason })
      continue
    }
    if (evaluation.warnings.includes('unattested')) warnings.push({ supplier_invoice_id: id, code: 'unattested' })
    if (evaluation.warnings.includes('ocr_invalid')) warnings.push({ supplier_invoice_id: id, code: 'ocr_invalid' })
    alternatives.set(id, payee.alternative ? formatPayeeLabel(payee.alternative) : null)

    const reference = evaluation.reference
    // The provider takes a banking day from tomorrow on: a weekend, a Swedish
    // holiday or today itself is refused, so the date moves to the first day
    // it will take.
    const wantedDate = input.executionDate ?? evaluation.defaults.payment_date
    const executionDate = executionDateFor(wantedDate, input.today)
    if (executionDate !== wantedDate) warnings.push({ supplier_invoice_id: id, code: 'date_moved', from: wantedDate, to: executionDate })
    payloads.push({
      supplier_invoice_id: id,
      amount: evaluation.defaults.amount,
      currency: invoice.currency,
      requested_execution_date: executionDate,
      cash_account_id: input.cashAccountId,
      debtor_snapshot: debtor.debtor,
      ...payeeColumns(payee.payee),
      payee_iban: null,
      payee_bic: null,
      payee_name: supplier.name,
      payee_source: payee.source,
      // The file calls a non-OCR reference 'invoice_number'; to the bank it is a message.
      reference_type: reference.type === 'ocr' ? 'ocr' : 'message',
      reference: reference.value,
      idempotency_key: randomUUID(),
    })
    previewLines.push({
      supplier_invoice_id: id,
      supplier_name: supplier.name,
      supplier_invoice_number: invoice.supplier_invoice_number,
      amount: evaluation.defaults.amount,
      currency: invoice.currency,
      requested_execution_date: executionDate,
      date_moved_from: executionDate !== wantedDate ? wantedDate : null,
      payee: { type: payee.payee.type, label: formatPayeeLabel(payee.payee), source: payee.source },
      reference: { type: reference.type === 'ocr' ? 'ocr' : 'message', value: reference.value },
      warnings: evaluation.warnings.filter((w) => w === 'unattested' || w === 'ocr_invalid'),
      alternative_payee: payee.alternative ? formatPayeeLabel(payee.alternative) : null,
    })
  }

  if (payloads.length === 0) {
    return { ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE', details: { skipped } }
  }
  const draftIdsToReplace = payloads.flatMap((p) => staleDrafts.get(p.supplier_invoice_id as string) ?? [])

  if (input.dryRun) {
    // Every rule above ran; only the database's payee_check (decided inside
    // create_payment_orders) and the rows themselves are missing.
    return {
      ok: true,
      dryRun: true,
      preview: {
        cash_account_id: input.cashAccountId,
        debtor: { bank_name: debtor.debtor.bank_name, bic: debtor.debtor.bic },
        lines: previewLines,
        skipped,
        total_amount: Math.round(previewLines.reduce((sum, line) => sum + Number(line.amount), 0) * 100) / 100,
        currency: previewLines.length ? String(previewLines[0].currency) : 'SEK',
        replaces_drafts: draftIdsToReplace.length,
        payee_check: 'decided by the database at creation; a new or changed account is confirmed by a person at approval',
      },
    }
  }

  const writer = createServiceClient()
  if (draftIdsToReplace.length > 0) {
    // The database refuses a second open order per invoice, so the stale
    // drafts go first. Only drafts: the status filter keeps anything a person
    // approved meanwhile out of reach.
    const now = new Date().toISOString()
    const { data: cancelled, error: cancelError } = await writer
      .from('payment_orders')
      .update({ status: 'cancelled', cancelled_by: userId, cancelled_at: now })
      .in('id', draftIdsToReplace)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .select('id, supplier_invoice_id')
    if (cancelError) throw cancelError
    const replaced = (cancelled ?? []) as Array<{ id: string; supplier_invoice_id: string | null }>
    if (replaced.length > 0) {
      await logPaymentOrderEvents(
        writer,
        replaced.map((o) => ({
          company_id: companyId,
          payment_order_id: o.id,
          event_type: 'cancelled',
          from_status: 'draft',
          to_status: 'cancelled',
          provider_status: null,
          actor_user_id: userId,
          detail: { replaced_by_new_draft: true },
        })),
        log,
      )
    }
  }

  const { data: rpc, error: rpcError } = await writer.rpc('create_payment_orders', {
    p_company_id: companyId,
    p_orders: payloads,
    p_user_id: userId,
  })
  if (rpcError) throw rpcError
  const result = rpc as { ok: boolean; code?: string; details?: unknown; orders?: PaymentOrderRow[] }
  if (!result.ok) {
    log.warn('create_payment_orders refused', { code: result.code })
    return {
      ok: false,
      code: RPC_CODES[result.code ?? ''] ?? 'PAYMENT_ORDERS_INELIGIBLE',
      details: { rpc_code: result.code, rpc_details: result.details as Record<string, unknown> | undefined },
    }
  }
  const orders = result.orders ?? []
  // A person confirms these accounts at approval (approvePaymentOrders).
  for (const order of orders) {
    if (!order.supplier_invoice_id) continue
    if (order.payee_check === 'changed') {
      warnings.push({ supplier_invoice_id: order.supplier_invoice_id, code: 'payee_changed', alternative_payee: alternatives.get(order.supplier_invoice_id) ?? null })
    } else if (order.payee_check === 'new') {
      warnings.push({ supplier_invoice_id: order.supplier_invoice_id, code: 'payee_new' })
    }
  }
  return { ok: true, data: { orders, skipped, warnings, replaced_draft_ids: draftIdsToReplace } }
}
