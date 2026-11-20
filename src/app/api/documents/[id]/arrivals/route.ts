import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { dbError } from '@/lib/errors/db-error'
import { listArrivalsForOutputs, summariseArrivals } from '@/lib/intake/arrivals'
import { PRIVATE_NO_STORE_HEADERS } from '@/lib/api/private-no-store'

const ParamsSchema = z.object({ id: z.string().uuid() })

/**
 * GET /api/documents/:id/arrivals
 *
 * How this document came in: every arrival (mail, chat message, e-invoice,
 * upload, API) that produced it, oldest first, with the sender, subject and
 * message text, and a short-lived signed URL of the original as it came (the
 * whole .eml, the XML, the provider payload). The Inkorg reads it for
 * "Visa originalet" and "Kom även via".
 *
 * A later version of a document answers for the arrivals of the first one
 * too: a new version does not arrive, it replaces.
 *
 * The originals are signed with the service-role client, as GET
 * /api/documents/:id signs the document: the row reads here (RLS plus the
 * explicit company filter) say which arrivals the caller sees, and
 * summariseArrivals signs an original only from the company's own storage.
 * The answer carries signed URLs and sender addresses: never cached.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.arrivals',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'must be a UUID' },
      })
    }
    const { id } = parsed.data

    const { data: doc, error } = await supabase
      .from('document_attachments')
      .select('id, original_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw dbError(error)
    if (!doc) return errorResponseFromCode('NOT_FOUND', log, { requestId, details: { resource: 'document' } })

    const documentIds = [doc.id as string, ...(doc.original_id && doc.original_id !== doc.id ? [doc.original_id as string] : [])]
    const arrivals = await listArrivalsForOutputs(
      supabase,
      companyId,
      documentIds.map((documentId) => ({ kind: 'document' as const, id: documentId })),
    )
    const summaries = await summariseArrivals(arrivals, { storageClient: createServiceClient() })

    return NextResponse.json({ data: summaries }, { headers: PRIVATE_NO_STORE_HEADERS })
  },
)
