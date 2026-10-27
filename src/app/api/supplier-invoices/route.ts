import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'
import { loadOpenPaymentInstructions } from '@/lib/supplier-invoices/lifecycle-stages'
import { SETTLED_SUPPLIER_INVOICE_STATUSES } from '@/lib/supplier-invoices/stages'
import { payableSupplierInvoiceStatuses } from '@/lib/supplier-invoices/lifecycle'

export const GET = withRouteContext(
  'supplier_invoice.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const supplierId = searchParams.get('supplier_id')

    // Paged: the list used to end at 1,000 invoices.
    let data: unknown[]
    try {
      // to_pay is the rows Markera som betald is offered for, which hangs on
      // whether the company attests (kontantmetoden does not, crm#1141).
      let toPayStatuses: readonly string[] = []
      if (status === 'to_pay') {
        const { data: settings, error: settingsError } = await supabase
          .from('company_settings')
          .select('accounting_method')
          .eq('company_id', companyId)
          .maybeSingle()
        if (settingsError) throw settingsError
        toPayStatuses = payableSupplierInvoiceStatuses(
          (settings?.accounting_method as string | null | undefined) ?? null,
        )
      }

      data = await fetchAllRows<unknown>(({ from, to }) => {
        let query = supabase
          .from('supplier_invoices')
          .select('*, supplier:suppliers(id, name)')
          .eq('company_id', companyId)

        // Optional narrowing to one supplier: the supplier detail page only
        // needs that supplier's invoices, not the whole company ledger.
        if (supplierId) {
          query = query.eq('supplier_id', supplierId)
        }

        if (status && status !== 'all') {
          if (status === 'to_pay') {
            // One the supplier debits itself has nothing to pay (crm#1463).
            query = query.in('status', [...toPayStatuses]).eq('auto_debit', false)
          } else {
            query = query.eq('status', status)
          }
        }

        return query.order('due_date', { ascending: true }).order('id', { ascending: true }).range(from, to)
      })
      // Each unsettled invoice carries the payment instruction that already
      // covers it (an open bank payment or payment file), read the same way
      // as the lifecycle stage, so a person deciding what to pay sees that a
      // payment is under way (crm#1243). Null when nothing covers it.
      const rows = data as Array<{ id: string; status: string }>
      const unsettledIds = rows.filter((r) => !SETTLED_SUPPLIER_INVOICE_STATUSES.has(r.status)).map((r) => r.id)
      const open = await loadOpenPaymentInstructions(supabase, companyId, unsettledIds)
      data = rows.map((r) => ({ ...r, open_payment: open.get(r.id) ?? null }))
    } catch (error) {
      log.error('supplier_invoice list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'supplier_invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSupplierInvoiceSchema, {
      log,
      operation: 'supplier_invoice.create',
    })
    if (!validation.success) return validation.response

    // Every rule lives in the shared service, so this door and the v1 REST
    // door register an invoice the same way (lib/supplier-invoices/create.ts).
    const result = await createSupplierInvoice(
      { supabase, companyId, userId: user.id, log },
      validation.data,
    )
    if (!result.ok) {
      if (result.error) return errorResponse(result.error, log, { requestId })
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    if (result.dryRun) {
      // Unreachable: this door never asks for a dry run.
      return NextResponse.json({ data: result.preview })
    }

    return NextResponse.json({
      data: {
        ...result.invoice,
        items: result.items,
        registration_journal_entry_id: result.registrationJournalEntryId,
        payment_journal_entry_id: result.paymentJournalEntryId,
        expense_claim: result.expenseClaim,
      },
      ...(result.warnings.length > 0
        ? { warnings: result.warnings.map((w) => ({ code: w.code, message: w.message_sv })) }
        : {}),
    })
  },
  { requireWrite: true },
)
