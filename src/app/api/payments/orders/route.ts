import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { preparePaymentOrders } from '@/lib/payments/orders/prepare'
import { PAYMENT_ORDER_STATUSES } from '@/lib/payments/orders/status'
import { todayIsoStockholm } from '@/lib/dates/iso'

ensureInitialized()

const PrepareSchema = z.object({
  supplier_invoice_ids: z.array(z.uuid()).min(1).max(100),
  cash_account_id: z.uuid(),
  execution_date: z.iso.date().nullish(),
  use_stated_payee_for: z.array(z.uuid()).max(100).optional(),
})

/**
 * GET /api/payments/orders: the company's bank payment orders, newest first.
 * ?status=draft,approved narrows; ?supplier_invoice_id=... finds one invoice's orders.
 */
export const GET = withRouteContext('payment_orders.list', async (request, { supabase, companyId }) => {
  const url = new URL(request.url)
  const statuses = (url.searchParams.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is (typeof PAYMENT_ORDER_STATUSES)[number] => (PAYMENT_ORDER_STATUSES as readonly string[]).includes(s))
  const invoiceId = url.searchParams.get('supplier_invoice_id')

  let query = supabase
    .from('payment_orders')
    .select('*, supplier_invoice:supplier_invoices(id, supplier_invoice_number, due_date, supplier:suppliers(name))')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (statuses.length) query = query.in('status', statuses)
  if (invoiceId && z.uuid().safeParse(invoiceId).success) query = query.eq('supplier_invoice_id', invoiceId)
  const { data, error } = await query
  if (error) throw error
  return NextResponse.json({ data: data ?? [] })
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
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
