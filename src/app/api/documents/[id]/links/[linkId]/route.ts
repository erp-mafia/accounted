import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * DELETE /api/documents/[id]/links/[linkId]
 * Retires a link. Links are never deleted: the row keeps who made it and
 * why it was retired, and a derivation may make the same link again.
 */
export const DELETE = withRouteContext('document.links.retire', async (_request, ctx, { params }: { params: Promise<{ id: string; linkId: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id, linkId } = await params
  const { data, error } = await createServiceClient()
    .from('document_links')
    .update({ retired_at: new Date().toISOString(), retired_reason: `retired by person ${ctx.user.id}` })
    .eq('id', linkId)
    .eq('document_id', id)
    .eq('company_id', ctx.companyId)
    .is('retired_at', null)
    .select('id')
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  ctx.log.info('document link retired', { doc: id, link: linkId })
  return NextResponse.json({ data: { id: linkId, retired: true } })
})
