import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { storeAnalyticsConsent } from '@/lib/legal/acceptance'

const log = createLogger('api/user/analytics-consent')

const BodySchema = z.object({ granted: z.boolean() }).strict()

/**
 * GET / PUT /api/user/analytics-consent: the person's own choice about
 * product analytics in the browser (PostHog analytics, masked session replay,
 * surveys), changed under Inställningar → Konto after the acceptance prompt
 * asked it the first time. The browser starts PostHog only while it is true
 * (lib/analytics/client.ts); the settings switch reloads the page after a
 * change so the new choice takes effect at once.
 *
 * requireAuth directly, like /api/user/preferences: the choice belongs to
 * the person and must work without an active company. Browser-only
 * (session-route-parity: ui-only): consent is never given by an agent.
 */
export async function GET() {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const { data, error } = await supabase
    .from('user_preferences')
    .select('analytics_consent, analytics_consent_at')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return errorResponse(error, log)

  const row = data as { analytics_consent?: boolean | null; analytics_consent_at?: string | null } | null
  return NextResponse.json({
    data: { granted: row?.analytics_consent ?? null, decided_at: row?.analytics_consent_at ?? null },
  })
}

export async function PUT(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const parsed = await validateBody(request, BodySchema)
  if (!parsed.success) return parsed.response

  try {
    await storeAnalyticsConsent(supabase, user.id, parsed.data.granted)
  } catch (err) {
    return errorResponse(err, log)
  }
  return NextResponse.json({ data: { granted: parsed.data.granted } })
}
