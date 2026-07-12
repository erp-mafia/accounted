import { NextResponse } from 'next/server'

/**
 * Public, unauthenticated build-version probe.
 *
 * The client compares the id it was built with (NEXT_PUBLIC_BUILD_ID, inlined
 * into its JS bundle at build time) against this value, which is read at
 * request time from the currently running deployment. A mismatch means a newer
 * deploy is live and the open tab is running a stale bundle, so the client
 * offers a reload (see components/system/DeployReloadPrompt).
 *
 * force-dynamic + no-store so it always reflects the live deployment rather
 * than a value baked in at build.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  const id = process.env.VERCEL_GIT_COMMIT_SHA ?? ''
  return NextResponse.json({ id }, { headers: { 'Cache-Control': 'no-store' } })
}
