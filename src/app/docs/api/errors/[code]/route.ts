import { NextResponse } from 'next/server'
import { ERROR_CODE_SEGMENT, docsUrlFor } from '@/lib/api/v1/error-docs'

/**
 * `/docs/api/errors/<CODE>`: the per-code address the v1 error envelope's
 * `docs_url` carried until 2026-11. The docs site has no page per code, so a
 * stored link is forwarded to the code's anchor in the error catalogue.
 * next.config.ts keeps this path out of its /docs/api/* forward so the
 * request reaches this route.
 */
const CODE = new RegExp(`^${ERROR_CODE_SEGMENT}$`)

export async function GET(_request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params
  if (!CODE.test(code)) return new NextResponse(null, { status: 404 })
  return NextResponse.redirect(docsUrlFor(code), 308)
}
