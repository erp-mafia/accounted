import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { setDocumentTypeByPerson } from '@/lib/documents/classify/set-type'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'

/**
 * POST /api/documents/[id]/classification  { doc_type }
 * A person says what the document is: the rules are in
 * lib/documents/classify/set-type.ts, which an approved
 * gnubok_set_document_type runs too.
 */
const bodySchema = z.object({ doc_type: z.enum(DOC_TYPES) })

export const POST = withRouteContext('document.classification', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const parsed = await validateBody(request, bodySchema)
  if (!parsed.success) return parsed.response

  const out = await setDocumentTypeByPerson(createServiceClient(), {
    companyId: ctx.companyId,
    documentId: id,
    userId: ctx.user.id,
    docType: parsed.data.doc_type,
  })
  if (out.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (out.status === 'error') return NextResponse.json({ error: out.reason }, { status: 500 })
  ctx.log.info('document type set by person', { doc: id, type: parsed.data.doc_type, withdrawn: out.withdrawnAgreementId })
  return NextResponse.json({ data: { document_id: id, doc_type: parsed.data.doc_type } })
}, { requireWrite: true })
