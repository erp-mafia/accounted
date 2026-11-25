import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition } from '@/lib/extensions/types'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { appendableSIEYears } from '@/lib/import/sie-append'
import {
  FORTNOX_SIE_PROGRAM,
  FORTNOX_TOPUP_KEY,
  readFortnoxTopup,
  type FortnoxTopupSetting,
} from './fortnox-topup'

const ToggleSchema = z.object({ consentId: z.string().uuid(), enabled: z.boolean() }).strict()

const log = createLogger('ext:arcim-migration:fortnox-topup')

/**
 * The nightly top-up's switch on a Fortnox connection (lib/fortnox-topup.ts).
 * The dispatcher enforces sign-in, MFA and company membership, and refuses
 * a viewer before the handler runs (requireWrite), as every other write of
 * the connection: whoever may import through it may turn this on, and the
 * night's imports are theirs.
 */
export const fortnoxTopupRoutes: ApiRouteDefinition[] = [
  {
    method: 'PUT',
    path: '/fortnox-topup',
    requireWrite: true,
    handler: async (request, ctx) => {
      const body = await validateBody(request, ToggleSchema)
      if (!body.success) return body.response
      const { consentId, enabled } = body.data
      try {
        const { data: consent, error } = await ctx.supabase.from('provider_consents').select('id,provider,status')
          .eq('id', consentId).eq('company_id', ctx.companyId).maybeSingle()
        if (error) throw new Error(error.message)
        const row = consent as { provider: string | null; status: number | null } | null
        if (!row || row.status !== 1) {
          return errorResponseFromCode('PROVIDER_CONSENT_NOT_FOUND', log, { requestId: ctx.requestId, details: { consentId } })
        }
        if (row.provider !== 'fortnox') {
          return errorResponseFromCode('VALIDATION_ERROR', log, {
            requestId: ctx.requestId,
            messageSv: 'Nattlig hämtning av nya verifikationer finns bara för en Fortnox-anslutning.',
            messageEn: 'The nightly fetch of new vouchers is only available for a Fortnox connection.',
            details: { field: 'consentId', reason: 'not_fortnox' },
          })
        }
        // Refused at once rather than at night: a top-up with no year to add
        // to would only stop.
        if (enabled && (await appendableSIEYears(ctx.supabase, ctx.companyId, FORTNOX_SIE_PROGRAM)).length === 0) {
          return errorResponseFromCode('PROVIDER_TOPUP_NO_OPEN_YEAR', log, { requestId: ctx.requestId })
        }
        const setting: FortnoxTopupSetting = { enabled, consentId, changedBy: ctx.userId, changedAt: new Date().toISOString() }
        await ctx.settings.set(FORTNOX_TOPUP_KEY, setting)
        return NextResponse.json({ data: await readFortnoxTopup(ctx.settings, ctx.supabase, ctx.companyId) })
      } catch (error) {
        ctx.log.error('fortnox top-up switch failed', error as Error, { enabled })
        return errorResponseFromCode('INTERNAL_ERROR', log, { requestId: ctx.requestId })
      }
    },
  },
]
