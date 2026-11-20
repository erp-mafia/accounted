import { NextResponse } from 'next/server'
import { isReturnBounceTarget, RETURN_BOUNCE_TARGET_PARAM } from '@/lib/connect/return-bounce'
import { getCanonicalAppOrigin, resolveTrustedAppOrigin } from '@/lib/domains/trusted-app-origin'

/**
 * GET /api/bank/return: forwards a bank's redirect return from the canonical
 * origin to the origin the person signed on (lib/connect/return-bounce.ts).
 * Public on purpose: the browser arrives from the bank and the target page
 * checks the session itself. The target must be a trusted app origin (the
 * canonical host, this deployment's own hosts or a registered brand domain)
 * and one of the signing pages, so the hop can never send anyone elsewhere;
 * anything else lands on the canonical start page. 303: the browser GETs it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const incoming = new URL(request.url)
  const fallback = new URL('/', getCanonicalAppOrigin())
  let target: URL
  try {
    target = new URL(incoming.searchParams.get(RETURN_BOUNCE_TARGET_PARAM) ?? '')
  } catch {
    return NextResponse.redirect(fallback, 303)
  }
  const trusted = await resolveTrustedAppOrigin(target.host, { onLookupFailure: 'canonical' })
  if (trusted !== target.origin || !isReturnBounceTarget(target.pathname)) {
    return NextResponse.redirect(fallback, 303)
  }
  for (const [name, value] of incoming.searchParams) {
    if (name !== RETURN_BOUNCE_TARGET_PARAM) target.searchParams.set(name, value)
  }
  return NextResponse.redirect(target, 303)
}
