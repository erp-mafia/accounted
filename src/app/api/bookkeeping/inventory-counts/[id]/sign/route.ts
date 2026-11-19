import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { declaredDocumentType } from '@/lib/core/documents/document-service'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { signStockCountManually } from '@/lib/bokslut/stock-count/signing'
import { SignStockCountSchema } from '@/lib/bokslut/stock-count/schemas'
import { stockCountDisabledResponse, stockCountErrorResponse } from '@/lib/bokslut/stock-count/route-errors'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/bookkeeping/inventory-counts/[id]/sign: the list signed by hand
 * "på heder och samvete" (LIV 2 §). multipart/form-data: signer_name,
 * signed_on (YYYY-MM-DD) and, optionally, file: the signed paper list
 * scanned, archived as the count's signed copy. The count is frozen from
 * here and the bokslut checklist's inventory step is marked done.
 */
export const POST = withRouteContext<Params>(
  'bookkeeping.inventory-counts.sign',
  async (request, ctx, { params }) => {
    if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
    const { id } = await params
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      // Not a multipart body: the caller's mistake, answered as such.
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { reason: 'multipart form expected' } })
    }
    const parsed = SignStockCountSchema.safeParse({ signer_name: form.get('signer_name'), signed_on: form.get('signed_on') })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    const upload = form.get('file')
    const file = upload instanceof File && upload.size > 0
      ? { name: upload.name, buffer: await upload.arrayBuffer(), type: declaredDocumentType({ name: upload.name, type: upload.type }) }
      : null
    try {
      const count = await signStockCountManually(ctx.supabase, ctx.companyId, ctx.user.id, id, {
        signerName: parsed.data.signer_name,
        signedOn: parsed.data.signed_on,
        file,
      })
      return NextResponse.json({ data: count })
    } catch (err) {
      const response = stockCountErrorResponse(err, ctx)
      if (response) return response
      throw err
    }
  },
  { requireWrite: true },
)
