import { NextResponse } from 'next/server'
import { buildResourcePages, RESOURCE_SLUGS } from '@/lib/docs/content/reference'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'

// Pre-validate the slug against the closed allow-list before any lookup
// runs. Defense-in-depth (V1.2.5): the lookup is array-find on a
// memoised in-process collection so a bad slug couldn't escape into a
// SQL or filesystem path, but the explicit allow-list gate keeps the
// contract safe by construction if the lookup mechanism ever changes.
const SLUG_ALLOW = new Set<string>(RESOURCE_SLUGS)

// Next.js 16 does not extract the dynamic segment name from a directory
// like `[slug].md/`: the literal `.md` suffix breaks the inference and
// the framework types `params` as `{}`. Workaround: parse the slug from
// request.url.pathname directly. Routing still works (Next.js still
// matches /docs/api/reference/foo.md to this handler): only the
// `params` typing is unusable.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const match = url.pathname.match(/\/reference\/([^/]+)\.md$/)
  const raw = match?.[1]
  // URL-decode before the allow-list check so a percent-encoded slug
  // can't slip through the literal Set lookup. Same pattern as the
  // cookbook .md route handler.
  let slug: string | undefined
  try {
    slug = raw ? decodeURIComponent(raw) : undefined
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
  if (!slug || !SLUG_ALLOW.has(slug)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const page = buildResourcePages().find((p) => p.slug === slug)
  if (!page) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(page.markdown, {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}
