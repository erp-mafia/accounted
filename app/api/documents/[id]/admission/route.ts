import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { deleteDocument } from '@/lib/core/documents/document-service'
import { recordHumanClassification } from '@/lib/documents/classify/classify'
import { isDocType } from '@/lib/documents/classify/taxonomy'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/documents/[id]/admission  { decision: 'admit' | 'discard', reason? }
 * The answer to "Är du säker på att det här rör bolaget?". Admit records a
 * human classification (relevance relevant, keeping the model's type) and
 * starts retention; discard removes the held file, which never became
 * räkenskapsinformation. Only held documents can be discarded here.
 */
const bodySchema = z.object({
  decision: z.enum(['admit', 'discard']),
  reason: z.string().trim().max(500).optional(),
})

export const POST = withRouteContext('document.admission', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const parsed = await validateBody(request, bodySchema)
  if (!parsed.success) return parsed.response

  const { data: doc, error } = await ctx.supabase
    .from('document_attachments')
    .select('id, company_id, admission_state, doc_type, file_name')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const row = doc as { id: string; admission_state: 'held' | 'admitted'; doc_type: string | null; file_name: string }
  if (row.admission_state !== 'held') return NextResponse.json({ error: 'Dokumentet är redan antaget.' }, { status: 409 })

  const service = createServiceClient()
  if (parsed.data.decision === 'discard') {
    const result = await deleteDocument(service, ctx.companyId, id)
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
    ctx.log.info('held document discarded', { doc: id })
    return NextResponse.json({ data: { document_id: id, decision: 'discard' } })
  }
  const docType = isDocType(row.doc_type) ? row.doc_type : 'other'
  const out = await recordHumanClassification(service, id, ctx.user.id, { docType, relevance: 'relevant', reason: parsed.data.reason })
  if (out.status !== 'classified') return NextResponse.json({ error: 'reason' in out ? out.reason : 'Kunde inte spara.' }, { status: 500 })
  ctx.log.info('held document admitted', { doc: id, type: docType })
  return NextResponse.json({ data: { document_id: id, decision: 'admit', doc_type: docType } })
})
