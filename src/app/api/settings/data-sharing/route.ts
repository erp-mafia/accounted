import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { DATA_CHOICES, type DataChoice } from '@/lib/legal/data-choices'
import { readCompanyDataChoices, setCompanyDataChoice } from '@/lib/legal/data-choices-store'

const PatchSchema = z
  .object({
    ai: z.boolean().optional(),
    pooling: z.boolean().optional(),
    contribution: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one choice is required' })

/**
 * GET / PATCH /api/settings/data-sharing: the company's data choices
 * (Inställningar → Datadelning och AI, lib/legal/data-choices.ts): AI
 * processing, pooled anonymous patterns, content contribution.
 *
 * Every member reads them; owners and admins change them (requireAdmin, and
 * set_company_data_choice asks the same predicate again). Each change is a
 * company_capability_config row with who decided and a dated line in
 * behandlingshistorik. Browser-only (session-route-parity: ui-only): what a
 * company lets us do with its data is decided by a person, never an agent.
 */
export const GET = withRouteContext('settings.data_sharing.read', async (_request, { supabase, companyId }) => {
  const choices = await readCompanyDataChoices(supabase, companyId)
  return NextResponse.json({ data: choices })
})

export const PATCH = withRouteContext(
  'settings.data_sharing.update',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response

    const service = createServiceClient()
    for (const choice of DATA_CHOICES) {
      const enabled = validation.data[choice as DataChoice]
      if (enabled === undefined) continue
      const result = await setCompanyDataChoice(service, {
        companyId,
        choice,
        enabled,
        decidedBy: user.id,
        actorType: 'user',
      })
      if (!result.ok) return errorResponseFromCode('FORBIDDEN', log, { requestId, reason: result.code })
    }

    const choices = await readCompanyDataChoices(supabase, companyId)
    return NextResponse.json({ data: choices })
  },
  { requireAdmin: true },
)
