import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireWritePermission } from '@/lib/auth/require-write'

const RetrySchema = z.object({ consentId: z.uuid(), blockId: z.uuid() }).strict()
function failure(status: number) {
  return NextResponse.json({ error: { code: `INVOICE_COMPLETION_${status}`, message: 'Fakturaraderna kunde inte hämtas. Dina sparade framsteg finns kvar.',
    message_en: 'Invoice rows could not be retrieved. Your saved progress is preserved.' } }, { status })
}
function hasContext(ctx?: ExtensionContext): ctx is ExtensionContext { return !!ctx?.companyId && !!ctx.userId }

/** The extension dispatcher enforces MFA and company membership. Mutations also check write access here. */
export const invoiceCompletionRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET', path: '/invoice-completion',
    handler: async (_request, ctx) => {
      if (!hasContext(ctx)) return failure(401)
      const { data, error } = await createServiceClientNoCookies().rpc('invoice_completion_block_status', { p_company_id: ctx.companyId })
      if (error) { ctx.log.error('invoice completion status failed', error); return failure(500) }
      return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  {
    method: 'POST', path: '/invoice-completion/retry',
    handler: async (request, ctx) => {
      if (!hasContext(ctx)) return failure(401)
      const body = await validateBody(request, RetrySchema)
      if (!body.success) return body.response
      const write = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
      if (!write.ok) return write.response
      const { data: consent, error: lookupError } = await ctx.supabase.from('provider_consents').select('id')
        .eq('id', body.data.consentId).eq('company_id', ctx.companyId).eq('status', 1).eq('provider', 'fortnox').maybeSingle()
      if (lookupError) return failure(500)
      if (!consent) return failure(404)
      const { data, error } = await createServiceClientNoCookies().rpc('retry_invoice_completion_work', {
        p_company_id: ctx.companyId, p_consent_id: consent.id, p_block_id: body.data.blockId,
      })
      if (error?.message.includes('PROVIDER_AUTH_EXPIRED')) return errorResponseFromCode('PROVIDER_AUTH_EXPIRED', ctx.log)
      if (error) { ctx.log.error('invoice completion retry failed', error); return failure(500) }
      if (!data) return failure(409)
      // The existing cron owns scheduling. A click never starts a full migration.
      return NextResponse.json({ data: { queued: true } }, { status: 202 })
    },
  },
]
