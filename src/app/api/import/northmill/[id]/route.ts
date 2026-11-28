import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bankBrowserOriginAllowed, bankBrowserRequest } from '@/lib/bank-browser/client'

export const GET = withRouteContext('northmill.status', async (_request, ctx, { params }) => {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'INVALID_ID' }, { status: 400 })
  return bankBrowserRequest(ctx.companyId, ctx.user.id, `/sessions/${id}`)
}, { requireWrite: true })

export const DELETE = withRouteContext('northmill.cancel', async (request, ctx, { params }) => {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'INVALID_ID' }, { status: 400 })
  if (!bankBrowserOriginAllowed(request)) {
    return Response.json({ error: 'ORIGIN_REFUSED' }, { status: 403 })
  }
  return bankBrowserRequest(ctx.companyId, ctx.user.id, `/sessions/${id}`, 'DELETE')
}, { requireWrite: true })
