import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { SupplierInvoiceExistsQuerySchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/supplier-invoices/exists?supplier_id=<uuid>&number=<string>
 *
 * Index-only pre-submit duplicate lookup for the supplier-invoice editor's
 * advisory warning. Mirrors the partial unique index
 * idx_supplier_invoices_company_supplier_number:
 * (company_id, supplier_id, supplier_invoice_number)
 * WHERE supplier_invoice_number IS NOT NULL AND status NOT IN
 * ('credited','reversed'). The create route's structured 409 remains the
 * authoritative backstop; this endpoint only powers the early warning.
 */
export const GET = withRouteContext(
  'supplier_invoice.exists',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const validation = validateQuery(request, SupplierInvoiceExistsQuerySchema, {
      log,
      operation: 'supplier_invoice.exists',
    })
    if (!validation.success) return validation.response
    const { supplier_id, number } = validation.data

    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, status')
      .eq('company_id', companyId)
      .eq('supplier_id', supplier_id)
      .eq('supplier_invoice_number', number)
      .not('status', 'in', '(credited,reversed)')
      .limit(1)
      .maybeSingle()

    if (error) {
      log.error('supplier_invoice exists lookup failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({
      data: data ? { exists: true, existing: data } : { exists: false },
    })
  },
)
