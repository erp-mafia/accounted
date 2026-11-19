import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { attachInvoiceUnderlag, listInvoiceUnderlag } from '@/lib/invoices/invoice-underlag'
import { UUID_RE } from '@/lib/invariants/uuid'
import { AttachInvoiceUnderlagBody } from '@/lib/operations/invoice-underlag'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * The invoice page's Underlag section (accounted#42): the archived documents
 * the invoice rests on. GET lists them; POST links documents already in the
 * archive (the section uploads a new file through POST /api/documents first).
 * Same service as v1 and MCP (lib/invoices/invoice-underlag.ts). A link is a
 * reference: the document keeps its own verifikat, and nothing is sent.
 */

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.underlag.list',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'INVOICE_NOT_FOUND' }, log, requestId)
    const outcome = await listInvoiceUnderlag({ supabase, companyId: companyId! }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.underlag.attach',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'INVOICE_NOT_FOUND' }, log, requestId)
    const validation = await validateBody(request, AttachInvoiceUnderlagBody, { log, operation: 'invoice.underlag.attach' })
    if (!validation.success) return validation.response

    const outcome = await attachInvoiceUnderlag(
      { supabase, companyId: companyId! },
      { invoice_id: id, document_ids: validation.data.document_ids },
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
