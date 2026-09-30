import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { CreditSupplierInvoiceInputSchema, creditSupplierInvoice } from '@/lib/supplier-invoices/credit'

ensureInitialized()

/**
 * "Kreditera": credit a supplier invoice with a kreditfaktura. Rules live in
 * lib/supplier-invoices/credit.ts, shared with v1 supplier-invoices.credit
 * and gnubok_credit_supplier_invoice.
 *
 * The body is optional. Empty, the credit note is dated today and numbered
 * KREDIT-<original>. With inbox_item_id (a supplier's credit note in the
 * inbox, issue #2980) the credit takes that document's date, number and
 * file, and is refused unless the credit note is for the whole invoice.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.credit',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    let raw: unknown = {}
    try {
      const text = await request.text()
      if (text.trim()) raw = JSON.parse(text)
    } catch {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = CreditSupplierInvoiceInputSchema.safeParse(raw ?? {})
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        },
      })
    }

    const outcome = await creditSupplierInvoice(
      { supabase, companyId, userId: user.id, log: log.child({ supplierInvoiceId: id }) },
      id,
      parsed.data,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    // Response shape predates the service: the credit note row, its verifikat
    // and any non-blocking warnings.
    const warnings = (outcome.warnings ?? []).map((w) => ({ code: w.code, message: w.message_sv }))
    return NextResponse.json({
      data: outcome.data.credit_note,
      journal_entry_id: outcome.data.journal_entry_id,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  },
  { requireWrite: true },
)
