import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { recordHumanClassification } from '@/lib/documents/classify/classify'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { withdrawDerivedAgreement } from '@/lib/arkiv/agreements/store'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { isArkivBrainEnabled, isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// Classification emits document.classified; the inbox extension's handler must be wired to route it.
ensureInitialized()

/**
 * POST /api/documents/[id]/classification  { doc_type }
 * A person says what the document is. Becomes the current classification and
 * is never overridden by the model. An admitted document stays admitted; a
 * held one is admitted by this answer too (naming the type is saying it
 * belongs here). The type decides the schema, so the extraction is queued
 * again; what the old type derived (an agreement, its obligations, deadlines
 * and facts) is withdrawn unless the new type is the same kind of agreement.
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
  // Withdraw first, save the type after: a failed withdrawal leaves the old type in place with nothing
  // half-corrected, and the withdrawal is idempotent, so the person's retry finishes the job.
  const withdrawn = await withdrawDerivedAgreement(service, id, parsed.data.doc_type, `Dokumentet är ${parsed.data.doc_type}, inte ett avtal (rättat av en person)`)
  if (withdrawn.status === 'error') return NextResponse.json({ error: withdrawn.reason }, { status: 500 })
  const out = await recordHumanClassification(service, id, ctx.user.id, { docType: parsed.data.doc_type, relevance: 'relevant' })
  if (out.status !== 'classified') return NextResponse.json({ error: 'reason' in out ? out.reason : 'Kunde inte spara.' }, { status: 500 })
  // The brain reads the record out of the retyped document; the shelf keeps the type and the pages.
  if (isArkivBrainEnabled(ctx.companyId)) await enqueueDocumentJob(service, ctx.companyId, id, 'extract')
  ctx.log.info('document type set by person', { doc: id, type: parsed.data.doc_type, withdrawn: withdrawn.status === 'withdrawn' ? withdrawn.agreementId : null })
  return NextResponse.json({ data: { document_id: id, doc_type: parsed.data.doc_type } })
})
