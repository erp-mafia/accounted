import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { PRIVATE_NO_STORE_HEADERS } from '@/lib/api/private-no-store'
import { listDeletedCompanyExports } from '@/lib/company/deleted-company-export'

const log = createLogger('api/account/deleted-companies')

/**
 * GET /api/account/deleted-companies: the deleted companies whose full
 * archive this person can still download (terms 9.3: 18 months after the
 * deletion, owners and admins). Read by the card on Säkerhet.
 *
 * Person-scoped, not company-scoped: a person whose last company was deleted
 * has no company context (the middleware lets /api/account/ through for
 * them), so the route uses requireAuth(), which still enforces MFA on hosted.
 * The read uses the service client because RLS hides archived companies;
 * listDeletedCompanyExports filters on the signed-in user's own memberships.
 */
export async function GET() {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user } = auth

  try {
    const companies = await listDeletedCompanyExports(createServiceClient(), user.id)
    return NextResponse.json({ data: companies }, { headers: PRIVATE_NO_STORE_HEADERS })
  } catch (err) {
    return errorResponse(err, log)
  }
}
