import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { preparePaymentOrders } from '@/lib/payments/orders/prepare'
import { isBankConfirming, isSignableAgain, PAYMENT_ORDER_STATUSES } from '@/lib/payments/orders/status'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { INVOICE_DOCUMENT_COLUMNS } from '@/lib/payments/orders/invoice-document'
import { secondSignatureHere, secondSignatureViaApi } from '@/lib/payments/orders/second-signature'

const PrepareSchema = z.object({
  supplier_invoice_ids: z.array(z.uuid()).min(1).max(100),
  cash_account_id: z.uuid(),
  execution_date: z.iso.date().nullish(),
  use_stated_payee_for: z.array(z.uuid()).max(100).optional(),
  /** Every rule runs and the lines that would be created are answered; nothing is written. The dialog's preview. */
  dry_run: z.boolean().optional(),
})

/**
 * GET /api/payments/orders: the company's bank payment orders, newest first.
 * ?status=draft,approved narrows; ?supplier_invoice_id=... finds one invoice's orders,
 * ?salary_run_id=... one salary run's payments.
 * bank_confirming: signed, and the bank has not confirmed the payment yet.
 * sign_again: unsigned at the bank in a signing nobody is in (isSignableAgain).
 * sign_second: the bank waits for another signatory and takes that signature
 * through the API, so they sign here: decided per signing, as Kontrasignera
 * signs the whole basket (second-signature.ts).
 */
export const GET = withRouteContext('payment_orders.list', async (request, { supabase, companyId }) => {
  const url = new URL(request.url)
  const statuses = (url.searchParams.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is (typeof PAYMENT_ORDER_STATUSES)[number] => (PAYMENT_ORDER_STATUSES as readonly string[]).includes(s))
  const invoiceId = url.searchParams.get('supplier_invoice_id')
  const salaryRunId = url.searchParams.get('salary_run_id')

  // Named columns: what a person needs to follow a payment, never internals
  // such as the idempotency key. provider_error_message is a sanitised text.
  // The invoice brings what its document states, so the approver checks the
  // payment against the supplier's own invoice. provider_payment_id is read
  // for sign_again only and left out of the answer.
  let query = supabase
    .from('payment_orders')
    .select(
      `id, supplier_invoice_id, salary_run_id, employee_id, batch_id, status, amount, currency, requested_execution_date, cash_account_id, payee_type, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban, payee_name, payee_source, payee_check, reference_type, reference, end_to_end_id, provider, provider_payment_id, provider_status, provider_status_at, provider_error_code, provider_error_message, create_started_at, outcome_unknown_at, approved_by, approved_at, submitted_at, signed_at, executed_at, cancelled_at, matched_at, created_at, updated_at, supplier_invoice:supplier_invoices(supplier_invoice_number, supplier:suppliers(name), ${INVOICE_DOCUMENT_COLUMNS})`,
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (statuses.length) query = query.in('status', statuses)
  if (invoiceId && z.uuid().safeParse(invoiceId).success) query = query.eq('supplier_invoice_id', invoiceId)
  if (salaryRunId && z.uuid().safeParse(salaryRunId).success) query = query.eq('salary_run_id', salaryRunId)
  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []

  // An order still awaiting_signature in a signing that finished is not
  // waiting for anyone: the bank is confirming it (isBankConfirming). A
  // submitted order whose payment waits at the bank can be signed again when
  // nobody is in its signing (isSignableAgain). Only those orders' signings
  // are read.
  const signingIds = [
    ...new Set(
      rows
        .filter((r) => r.batch_id && (r.status === 'awaiting_signature' || (r.status === 'submitted' && r.provider_payment_id)))
        .map((r) => r.batch_id as string),
    ),
  ]
  const signingStatus = new Map<string, string>()
  if (signingIds.length > 0) {
    const { data: batches, error: batchError } = await supabase
      .from('payment_order_batches')
      .select('id, status')
      .eq('company_id', companyId)
      .in('id', signingIds)
    if (batchError) throw batchError
    for (const b of (batches ?? []) as Array<{ id: string; status: string }>) signingStatus.set(b.id, b.status)
  }
  const waitingForSecond = new Map<string, string[]>()
  for (const r of rows) {
    if (r.status === 'awaiting_second_signer' && r.batch_id) waitingForSecond.set(r.batch_id, [...(waitingForSecond.get(r.batch_id) ?? []), r.id])
  }
  const viaApi = await secondSignatureViaApi(supabase, companyId, [...waitingForSecond.values()].flat())
  const secondHere = new Set([...waitingForSecond].filter(([, ids]) => secondSignatureHere(ids, viaApi)).map(([batchId]) => batchId))
  return NextResponse.json({
    data: rows.map((row) => {
      const { provider_payment_id: _bankPaymentId, ...r } = row
      const signing = row.batch_id ? signingStatus.get(row.batch_id) : null
      return {
        ...r,
        bank_confirming: isBankConfirming(row, signing),
        sign_again: isSignableAgain(row, signing),
        sign_second: row.status === 'awaiting_second_signer' && row.batch_id !== null && secondHere.has(row.batch_id),
      }
    }),
  })
})

/**
 * POST /api/payments/orders: prepare draft bank payments for supplier
 * invoices. Nothing reaches the bank: drafts are approved and then signed
 * with BankID. The rules live in lib/payments/orders/prepare.ts.
 */
export const POST = withRouteContext(
  'payment_orders.prepare',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PrepareSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const outcome = await preparePaymentOrders(
      { supabase, companyId, userId: user.id, log },
      {
        supplierInvoiceIds: body.supplier_invoice_ids,
        cashAccountId: body.cash_account_id,
        executionDate: body.execution_date ?? null,
        useStatedPayeeFor: body.use_stated_payee_for,
        today: todayIsoStockholm(),
        dryRun: body.dry_run === true,
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
