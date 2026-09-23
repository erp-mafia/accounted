import { NextResponse } from 'next/server'
import { findRecipe, buildPlaceholderMd, COOKBOOK_SLUGS } from '@/lib/docs/content/cookbook'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'

// Pre-validate the slug against the closed allow-list before any lookup
// runs. Defense-in-depth (V1.2.5): findRecipe is dictionary-based so the
// raw value can't reach SQL or filesystem code paths, but if the lookup
// is ever swapped (e.g. dynamic file load) the explicit allow-list
// gate keeps the contract safe by construction.
const SLUG_ALLOW = new Set<string>(COOKBOOK_SLUGS)

// Next.js 16 does not extract the dynamic segment name from a directory
// like `[slug].md/`: the literal `.md` suffix breaks the inference and
// the framework types `params` as `{}`. Workaround: parse the slug from
// request.url.pathname directly. Routing still works (Next.js still
// matches /docs/api/cookbook/foo.md to this handler): only the
// `params` typing is unusable.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const match = url.pathname.match(/\/cookbook\/([^/]+)\.md$/)
  const raw = match?.[1]
  // URL-decode before the allow-list check so a percent-encoded slug
  // can't slip through the literal Set lookup. The allow-list is pure
  // ASCII so any decoded value matching means the caller could have
  // requested the canonical slug directly: no behaviour change for
  // legitimate clients, defense-in-depth for adversarial ones.
  let slug: string | undefined
  try {
    slug = raw ? decodeURIComponent(raw) : undefined
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
  if (!slug || !SLUG_ALLOW.has(slug)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const entry = findRecipe(slug)
  if (!entry) return new NextResponse('Not found', { status: 404 })

  const md = entry.markdown ?? buildPlaceholderMd(entry)
  return new NextResponse(md, {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}
