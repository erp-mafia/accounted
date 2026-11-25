import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { SupplierInvoiceExistsQuerySchema } from '@/lib/api/schemas'
import { lookupSupplierInvoiceDuplicates } from '@/lib/supplier-invoices/duplicate-lookup'

/**
 * GET /api/supplier-invoices/exists?supplier_id=<uuid>&number=<string>&reference=<string>
 *   [&invoice_date=<YYYY-MM-DD>&total=<amount>&currency=<code>]
 *
 * Pre-submit duplicate lookup for the supplier-invoice editor's advisory
 * warnings, among the supplier's live invoices (not credited, not reversed:
 * the predicate of idx_supplier_invoices_company_supplier_number). `number`,
 * `reference` or both:
 *
 *   - number: the invoice that holds it, with the verifikat it is booked on.
 *     The create route's structured 409 remains the authoritative backstop.
 *   - reference: the payment reference on other invoices of the supplier,
 *     under another number. Never refused anywhere: the editor asks for an
 *     acknowledgement while it sits on one invoice only, or when one of them
 *     is the same document again (`twin`: the same invoice_date and amount to
 *     pay, in the same currency).
 *
 * Every invoice named says where its payment stands (`payment`). The rules
 * live in lib/supplier-invoices/duplicate-lookup.ts.
 */
export const GET = withRouteContext(
  'supplier_invoice.exists',
  async (request, ctx) => {
    const { supabase, companyId, log } = ctx

    const validation = validateQuery(request, SupplierInvoiceExistsQuerySchema, {
      log,
      operation: 'supplier_invoice.exists',
    })
    if (!validation.success) return validation.response
    const { supplier_id, number, reference, invoice_date, total, currency } = validation.data

    const found = await lookupSupplierInvoiceDuplicates(supabase, companyId, {
      supplierId: supplier_id,
      number,
      reference,
      invoiceDate: invoice_date,
      total,
      currency,
    })

    return NextResponse.json({
      data: {
        // `exists` and `existing` answer the number, as they always did.
        exists: found.number !== null,
        ...(found.number ? { existing: found.number } : {}),
        ...(found.reference ? { reference: found.reference } : {}),
      },
    })
  },
)
