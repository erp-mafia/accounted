/**
 * Prepare bank payments for supplier invoices: one draft payment order per
 * invoice, from one of the company's own accounts.
 *
 * Eligibility, amount, default date and reference come from the same rules
 * the payment file uses (evaluateInvoiceForBatch), so the two channels never
 * disagree about what may be paid. The payee adds the invoice's own stated
 * account (resolveOrderPayee). Nothing reaches the bank here: a draft is
 * edited, approved by a person, and only then signed with BankID.
 */

import { randomUUID } from 'node:crypto'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { evaluateInvoiceForBatch, type BatchExclusionReason } from '@/lib/payments/batch-eligibility'
import { getPaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import { formatPayeeLabel, type SupplierPayee } from '@/lib/payments/supplier-payee'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { resolveDebtor } from './debtor'
import { resolveOrderPayee, type PayeeCheck } from './payee'
import type { PaymentOrderRow } from './types'

export interface PreparePaymentOrdersInput {
  supplierInvoiceIds: string[]
  cashAccountId: string
  /** YYYY-MM-DD. Defaults per invoice: the due date, or today when it has passed. */
  executionDate?: string | null
  /** Invoice ids where the person chose the account the invoice states over the supplier card. */
  useStatedPayeeFor?: string[]
  /** YYYY-MM-DD in Stockholm; injected so tests and the preview agree. */
  today: string
}

export type PrepareSkipReason = BatchExclusionReason | 'not_found' | 'in_payment_file' | 'already_in_payment'

export interface PreparedOrderWarning {
  supplier_invoice_id: string
  code: 'unattested' | 'ocr_invalid' | 'payee_changed' | 'payee_new'
  /** For payee warnings: the other account, so the person can compare. */
  alternative_payee?: string | null
}

export interface PreparePaymentOrdersResult {
  orders: PaymentOrderRow[]
  skipped: Array<{ supplier_invoice_id: string; reason: PrepareSkipReason }>
  warnings: PreparedOrderWarning[]
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
  invalid_payload: 'PAYMENT_ORDERS_EMPTY_SELECTION',
}

export async function preparePaymentOrders(
  ctx: OperationContext,
  input: PreparePaymentOrdersInput,
): Promise<OperationOutcome<PreparePaymentOrdersResult>> {
  const { supabase, companyId, userId, log } = ctx
  const ids = [...new Set(input.supplierInvoiceIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  if (!getPaymentInitiationProvider(companyId)) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
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
    .select('id, iban, currency, name, enabled, bank_connection:bank_connections(bank_name)')
    .eq('id', input.cashAccountId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!account) return { ok: false, code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE', details: { reason: 'not_found' } }
  const acct = account as unknown as {
    iban: string | null
    currency: string
    name: string | null
    enabled: boolean
    bank_connection: { bank_name: string | null } | null
  }
  const debtor = resolveDebtor(acct, acct.bank_connection?.bank_name ?? null)
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
    .select('supplier_invoice_id, status, supplier_invoice_payment_id')
    .eq('company_id', companyId)
    .in('supplier_invoice_id', ids)
  const inOpenOrder = new Set(
    ((openOrders ?? []) as Array<{ supplier_invoice_id: string; status: string; supplier_invoice_payment_id: string | null }>)
      .filter((o) => (o.status === 'executed' ? !o.supplier_invoice_payment_id : !['rejected', 'cancelled', 'failed'].includes(o.status)))
      .map((o) => o.supplier_invoice_id),
  )

  const useStated = new Set(input.useStatedPayeeFor ?? [])
  const skipped: PreparePaymentOrdersResult['skipped'] = []
  const warnings: PreparedOrderWarning[] = []
  const payloads: Record<string, unknown>[] = []
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
    const check: PayeeCheck = payee.check
    if (check === 'changed') {
      warnings.push({
        supplier_invoice_id: id,
        code: 'payee_changed',
        alternative_payee: payee.alternative ? formatPayeeLabel(payee.alternative) : null,
      })
    } else if (check === 'new') {
      warnings.push({ supplier_invoice_id: id, code: 'payee_new' })
    }

    const reference = evaluation.reference
    payloads.push({
      supplier_invoice_id: id,
      amount: evaluation.defaults.amount,
      currency: invoice.currency,
      requested_execution_date: input.executionDate ?? evaluation.defaults.payment_date,
      cash_account_id: input.cashAccountId,
      debtor_snapshot: debtor.debtor,
      ...payeeColumns(payee.payee),
      payee_iban: null,
      payee_bic: null,
      payee_name: supplier.name,
      payee_source: payee.source,
      payee_check: check,
      // The file calls a non-OCR reference 'invoice_number'; to the bank it is a message.
      reference_type: reference.type === 'ocr' ? 'ocr' : 'message',
      reference: reference.value,
      idempotency_key: randomUUID(),
    })
  }

  if (payloads.length === 0) {
    return { ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE', details: { skipped } }
  }

  const { data: rpc, error: rpcError } = await supabase.rpc('create_payment_orders', {
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
  return { ok: true, data: { orders: result.orders ?? [], skipped, warnings } }
}
