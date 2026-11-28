import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bankBrowserOriginAllowed, bankBrowserRequest } from '@/lib/bank-browser/client'

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), id: z.string().regex(/^[a-f0-9]{24}$/) }).strict(),
  z.object({ type: z.literal('export') }).strict(),
])

export const GET = withRouteContext('northmill.resource', async (_request, ctx, { params }) => {
  const { id, resource } = await params
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'INVALID_ID' }, { status: 400 })
  if (resource !== 'screen' && resource !== 'file') return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  return bankBrowserRequest(ctx.companyId, ctx.user.id, `/sessions/${id}/${resource}`)
}, { requireWrite: true })

export const POST = withRouteContext('northmill.action', async (request, ctx, { params }) => {
  const { id, resource } = await params
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'INVALID_ID' }, { status: 400 })
  if (resource !== 'action') return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (!bankBrowserOriginAllowed(request)) {
    return Response.json({ error: 'ORIGIN_REFUSED' }, { status: 403 })
  }
  const input = action.safeParse(await request.json().catch(() => null))
  if (!input.success) return Response.json({ error: 'INVALID_ACTION' }, { status: 400 })
  return bankBrowserRequest(ctx.companyId, ctx.user.id, `/sessions/${id}/action`, 'POST', input.data)
}, { requireWrite: true })
