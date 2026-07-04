/**
 * Canonical base URL for v1 surfaces.
 *
 * Use this, NOT `new URL(request.url).host`, when assembling URLs that go
 * into discovery files, OpenAPI specs, or any response a 3rd-party agent
 * caches. The inbound `Host` header is attacker-controlled at the edge; a
 * spoofed value would otherwise poison agent discovery and redirect them
 * to attacker-controlled endpoints.
 *
 * Honours `NEXT_PUBLIC_APP_URL` (the same env var the rest of the codebase
 * uses for absolute links). Falls back to `https://localhost:3000` for
 * local development when the env var is unset: this is a deliberate
 * fail-closed default that any production deploy will override.
 */

export function getCanonicalBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return 'http://localhost:3000'
}
