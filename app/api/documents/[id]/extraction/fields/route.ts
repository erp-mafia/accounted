import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { recordHumanFields } from '@/lib/documents/extract/store'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { agreementKindFor } from '@/lib/arkiv/agreements/derive'
import { hasFactPredicates } from '@/lib/arkiv/facts/predicates'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/documents/[id]/extraction/fields  { fields: { name: value } }
 * A person settles fields of the document's current record: a new current
 * extraction (pass 'human') on top of it, the settled fields out of review.
 * Values are stored as typed and normalized on the server. The model never
 * overwrites a person's record. An agreement is derived again from the
 * settled record.
 */
const bodySchema = z.object({
  fields: z
    .record(z.string().min(1).max(64), z.union([z.string().max(2000), z.number(), z.null()]))
    .refine((fields) => Object.keys(fields).length > 0, 'fields must not be empty'),
})

export const POST = withRouteContext('document.extraction.fields', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const parsed = await validateBody(request, bodySchema)
  if (!parsed.success) return parsed.response

  const { data: doc, error } = await ctx.supabase
    .from('document_attachments')
    .select('id')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const service = createServiceClient()
  const out = await recordHumanFields(service, id, ctx.user.id, parsed.data.fields)
  switch (out.status) {
    case 'extracted':
      if (agreementKindFor(out.schemaType) || hasFactPredicates(out.schemaType)) await enqueueDocumentJob(service, ctx.companyId, id, 'derive')
      ctx.log.info('document fields settled by person', { doc: id, fields: Object.keys(parsed.data.fields) })
      return NextResponse.json({ data: { document_id: id, extraction_id: out.extractionId, review_fields: out.reviewFields } })
    case 'skipped':
      if (out.reason === 'unknown_fields') return NextResponse.json({ error: 'Fältet finns inte för den här dokumenttypen.' }, { status: 400 })
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    case 'error':
      ctx.log.error('document fields save failed', { doc: id, reason: out.reason })
      return NextResponse.json({ error: 'Fälten kunde inte sparas. Försök igen.' }, { status: 500 })
  }
})
