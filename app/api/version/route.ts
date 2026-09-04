import { NextResponse, after } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { recordAppRelease } from '@/lib/reports/app-releases'

/**
 * Public, unauthenticated build-version probe.
 *
 * Returns the commit SHA Vercel built from, so a deploy can be verified from
 * outside without reading the dashboard. Empty string off Vercel.
 *
 * Kept deliberately free of anything else: this is the one endpoint used to
 * answer "is the fix live?".
 *
 * force-dynamic + no-store so it always reflects the live deployment rather
 * than a value baked in at build.
 *
 * Side effect (behandlingshistorik, BFNAR 2013:2 p. 9.16): the first request a
 * new build answers dates that version in `app_releases`. Every open tab polls
 * this route, so a new deploy is registered within seconds; the recorder is a
 * guarded no-op afterwards and never throws. It runs in after() rather than as
 * a floating promise because this handler returns synchronously: a bare void
 * would race the response and could be frozen before the insert lands, which
 * is how a version log ends up silently empty.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  const id = process.env.VERCEL_GIT_COMMIT_SHA ?? ''
  if (id) after(() => recordAppRelease(createServiceClient, id))
  return NextResponse.json({ id }, { headers: { 'Cache-Control': 'no-store' } })
}
