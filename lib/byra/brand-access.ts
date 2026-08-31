import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'

/**
 * Shared authorization for byrå brand write routes (WL-17).
 *
 * brands has no write RLS (rows are ops-managed), so every brand write goes
 * through the service client behind this explicit owner/admin check on the
 * caller's byrå team: the same authorization idiom as /api/team/members.
 */

export interface ByraBrandAccess {
  teamId: string
  serviceClient: ReturnType<typeof createServiceClient>
  errorResponse: NextResponse | null
}

/** Resolve the caller's byrå team and require owner/admin, or an error response. */
export async function requireByraBrandAccess(userId: string): Promise<ByraBrandAccess> {
  const serviceClient = createServiceClient()
  const membership = await getByraMembership(serviceClient, userId)
  if (!membership) {
    return {
      teamId: '',
      serviceClient,
      errorResponse: NextResponse.json({ error: 'Endast för byråteam.' }, { status: 403 }),
    }
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return {
      teamId: membership.teamId,
      serviceClient,
      errorResponse: NextResponse.json(
        { error: 'Endast ägare och administratörer kan ändra varumärket.' },
        { status: 403 },
      ),
    }
  }
  return { teamId: membership.teamId, serviceClient, errorResponse: null }
}
