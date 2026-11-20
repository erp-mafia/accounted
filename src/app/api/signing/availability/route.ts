import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { signingAvailability } from '@/lib/signing/requests'

/**
 * GET /api/signing/availability: what the active company may do with BankID
 * signing (the SIGNING_ENABLED rollout, a wired BankID provider, its plan
 * and the årsredovisning rollout). `offered` says the feature exists for it,
 * `available` that it may send documents, `arsredovisning` that it may send
 * a locked årsredovisning to its board. The dashboard hides every signing
 * affordance while `available` is false. Read-only; reading existing
 * requests and their signed copies never depends on it.
 */
export const GET = withRouteContext('signing.availability', async (_request, { supabase, companyId }) => {
  return NextResponse.json({ data: await signingAvailability(supabase, companyId) }, { headers: { 'Cache-Control': 'no-store' } })
})
