import { withRouteContext } from '@/lib/api/with-route-context'
import { bankBrowserConfigured, bankBrowserOriginAllowed, bankBrowserRequest } from '@/lib/bank-browser/client'

export const GET = withRouteContext('northmill.available', async () =>
  Response.json({ enabled: bankBrowserConfigured() }, { headers: { 'Cache-Control': 'no-store' } }), { requireWrite: true })

export const POST = withRouteContext('northmill.start', async (request, ctx) => {
  if (!bankBrowserOriginAllowed(request)) {
    return Response.json({ error: 'ORIGIN_REFUSED' }, { status: 403 })
  }
  const { data, error } = await ctx.supabase.from('companies').select('org_number').eq('id', ctx.companyId).single()
  if (error) return Response.json({ error: 'COMPANY_LOOKUP_FAILED' }, { status: 500 })
  const organizationNumber = String(data?.org_number || '').replace(/\D/g, '')
  if (!/^\d{10}$/.test(organizationNumber)) return Response.json({ error: 'COMPANY_NUMBER_REQUIRED' }, { status: 400 })
  return bankBrowserRequest(ctx.companyId, ctx.user.id, '/sessions', 'POST', { organizationNumber })
}, { requireWrite: true })
