import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { linkByPerson } from '@/lib/arkiv/agreements/store'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET  /api/documents/[id]/links            the live links of a document
 * POST /api/documents/[id]/links            { target_kind, target_id }
 * A person ties a document to a party, an agreement or an asset of the
 * company: basis proven, method person. The legal link to a verifikat is a
 * different route (POST /api/documents/[id]/link) and a different thing.
 */
export interface DocumentLinkView {
  id: string
  target_kind: 'party' | 'agreement' | 'asset'
  target_id: string
  basis: 'proven' | 'guessed'
  method: string
  confidence: number
  created_at: string
}

const bodySchema = z.object({
  target_kind: z.enum(['party', 'agreement', 'asset']),
  target_id: z.string().uuid(),
})

/** The target row, only if it is the company's (and, for a party, live). */
function findTarget(supabase: SupabaseClient, companyId: string, kind: 'party' | 'agreement' | 'asset', id: string) {
  switch (kind) {
    case 'party':
      return supabase.from('parties').select('id').eq('id', id).eq('company_id', companyId).is('merged_into', null).maybeSingle()
    case 'agreement':
      return supabase.from('agreements').select('id').eq('id', id).eq('company_id', companyId).maybeSingle()
    case 'asset':
      return supabase.from('assets').select('id').eq('id', id).eq('company_id', companyId).maybeSingle()
  }
}

export const GET = withRouteContext('document.links', async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const { data, error } = await ctx.supabase
    .from('document_links')
    .select('id, target_kind, target_id, basis, method, confidence, created_at')
    .eq('document_id', id)
    .eq('company_id', ctx.companyId)
    .is('retired_at', null)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  return NextResponse.json({ data: (data ?? []) as DocumentLinkView[] })
})

export const POST = withRouteContext('document.links.create', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const parsed = await validateBody(request, bodySchema)
  if (!parsed.success) return parsed.response
  const { target_kind: targetKind, target_id: targetId } = parsed.data

  const { data: doc, error: docError } = await ctx.supabase.from('document_attachments').select('id').eq('id', id).eq('company_id', ctx.companyId).maybeSingle()
  if (docError) return NextResponse.json({ error: getErrorMessage(docError) }, { status: 500 })
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: targetRow, error: targetError } = await findTarget(ctx.supabase, ctx.companyId, targetKind, targetId)
  if (targetError) return NextResponse.json({ error: getErrorMessage(targetError) }, { status: 500 })
  if (!targetRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const out = await linkByPerson(createServiceClient(), { companyId: ctx.companyId, documentId: id, userId: ctx.user.id, targetKind, targetId })
    if ('conflict' in out) return NextResponse.json({ error: 'Länken finns redan.' }, { status: 409 })
    ctx.log.info('document linked by person', { doc: id, target: targetKind })
    return NextResponse.json({ data: { id: out.id, document_id: id, target_kind: targetKind, target_id: targetId } }, { status: 201 })
  } catch (err) {
    ctx.log.error('document link failed', { doc: id, reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Länken kunde inte sparas. Försök igen.' }, { status: 500 })
  }
})
