import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'

ensureInitialized()

export const GET = withRouteContext(
  'supplier_invoice.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const supplierId = searchParams.get('supplier_id')

    let query = supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(id, name)')
      .eq('company_id', companyId)

    // Optional narrowing to one supplier — the supplier detail page only
    // needs that supplier's invoices, not the whole company ledger.
    if (supplierId) {
      query = query.eq('supplier_id', supplierId)
    }

    if (status && status !== 'all') {
      if (status === 'to_pay') {
        query = query.in('status', ['approved', 'overdue'])
      } else {
        query = query.eq('status', status)
      }
    }

    const { data, error } = await query.order('due_date', { ascending: true })

    if (error) {
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
