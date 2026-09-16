import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { recordHumanClassification } from '@/lib/documents/classify/classify'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// Classification emits document.classified; the inbox extension's handler must be wired to route it.
ensureInitialized()

/**
 * POST /api/documents/[id]/classification  { doc_type }
 * A person says what the document is. Becomes the current classification and
 * is never overridden by the model. An admitted document stays admitted; a
 * held one is admitted by this answer too (naming the type is saying it
 * belongs here). The type decides the schema, so the extraction is queued
 * again.
 */
const bodySchema = z.object({ doc_type: z.enum(DOC_TYPES) })

export const POST = withRouteContext('document.classification', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
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
  const out = await recordHumanClassification(service, id, ctx.user.id, { docType: parsed.data.doc_type, relevance: 'relevant' })
  if (out.status !== 'classified') return NextResponse.json({ error: 'reason' in out ? out.reason : 'Kunde inte spara.' }, { status: 500 })
  await enqueueDocumentJob(service, ctx.companyId, id, 'extract')
  ctx.log.info('document type set by person', { doc: id, type: parsed.data.doc_type })
  return NextResponse.json({ data: { document_id: id, doc_type: parsed.data.doc_type } })
})
