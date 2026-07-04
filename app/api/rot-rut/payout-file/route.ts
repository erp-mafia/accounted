import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RotRutPayoutFileSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createRotRutPayoutRequest } from '@/lib/invoices/rot-rut-service'
import { uploadDocument } from '@/lib/core/documents/document-service'

/**
 * POST /api/rot-rut/payout-file
 *
 * Generates the begäran-om-utbetalning XML (Skatteverket husavdrag, schema
 * V6) for the selected invoices, records a rot_rut_payout_requests row (one
 * active begäran per invoice, DB-enforced), archives the file as
 * räkenskapsinformation, and returns the XML for download.
 *
 * All-or-nothing: if any selected invoice fails eligibility the request is
 * rejected with per-invoice blockers: a silently thinner file would be a
 * guess about the user's intent.
 *
 * DELIBERATE: the XML (which embeds buyers' personnummer, as Skatteverkets
 * schema requires) is returned inline. The file only exists to be saved and
 * uploaded manually on skatteverket.se: there is no UI download surface for
 * this headless flow, and a document-reference indirection would dead-end the
 * user whenever the (best-effort) archive failed. Transport is TLS,
 * authenticated, MFA-gated and write-role-gated via withRouteContext.
 */
export const POST = withRouteContext(
  'rot_rut.payout_file',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, RotRutPayoutFileSchema)
    if (!validation.success) return validation.response
    const input = validation.data

    const result = await createRotRutPayoutRequest(supabase, companyId!, user.id, {
      type: input.deduction_type,
      invoiceIds: input.invoice_ids,
      name: input.name,
    })

    if (!result.ok) {
      return errorResponseFromCode(result.code, log, {
        requestId,
        details: {
          ...(result.blockers ? { blockers: result.blockers } : {}),
          ...(result.missingInvoiceIds ? { missing_invoice_ids: result.missingInvoiceIds } : {}),
        },
      })
    }

    // Archive the XML as räkenskapsinformation (7-year retention via the
    // document WORM chain). Best-effort: the user gets the file either way
    // and can re-generate; a failed archive must not orphan the begäran.
    let fileDocumentId: string | null = null
    try {
      const buffer = new TextEncoder().encode(result.file.xml!).buffer as ArrayBuffer
      const doc = await uploadDocument(
        supabase,
        user.id,
        companyId!,
        { name: result.file.file_name, buffer },
        { upload_source: 'system' },
      )
      fileDocumentId = doc.id
      await supabase
        .from('rot_rut_payout_requests')
        .update({ file_document_id: doc.id })
        .eq('id', result.request.id as string)
    } catch (docError) {
      log.error('failed to archive rot/rut payout file document', docError as Error)
    }

    log.info('rot/rut payout file generated', {
      requestId: result.request.id,
      type: input.deduction_type,
      arenden: result.file.arenden.length,
      requestedTotal: result.file.requested_total,
    })

    return NextResponse.json({
      data: {
        request: { ...result.request, file_document_id: fileDocumentId },
        xml: result.file.xml,
        file_name: result.file.file_name,
        arenden: result.file.arenden,
        warnings: result.file.warnings,
      },
    })
  },
  { requireWrite: true },
)
