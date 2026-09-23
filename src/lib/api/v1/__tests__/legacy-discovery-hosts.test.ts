import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * Drift guard for LEGACY_DISCOVERY_HOSTS (issue #1093).
 *
 * The constants below pin the configuration actually registered in
 * production: the canonical app host after the accounted.se cutover, and
 * the Skatteverket OAuth redirect_uri host registered in Utvecklarportalen
 * (pinned via NEXT_PUBLIC_SKV_OAUTH_BASE_URL on Vercel, kept on the legacy
 * domain because the registration is slow to change).
 *
 * If either registration changes, update these constants in the same PR
 * that changes LEGACY_DISCOVERY_HOSTS or the env pin. A red test here means
 * the discovery allowlist and the registered OAuth configuration disagree,
 * which in production surfaces as MCP clients re-authenticating against a
 * mismatched issuer and AGI/moms staging failing silently.
 */
const CANONICAL = 'https://app.accounted.se'
const SKV_OAUTH_PIN = 'https://app.gnubok.se'

/**
 * CI does not set these env vars, so every test stubs them explicitly and
 * re-imports the module to be robust against env reads being hoisted to
 * module scope in a future refactor.
 */
async function loadValidator() {
  vi.resetModules()
  const mod = await import('../base-url')
  return mod.validateLegacyDiscoveryHosts
}

describe('validateLegacyDiscoveryHosts', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('passes for the registered production configuration', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', SKV_OAUTH_PIN)
    const validate = await loadValidator()
    expect(validate()).toEqual([])
  })

  it('reports an allowlisted host orphaned from the registered configuration', async () => {
    // Direction (b): with the SKV pin moved elsewhere and the canonical host
    // on accounted.se, nothing registered accounts for app.gnubok.se anymore,
    // so the validator must flag the allowlist entry instead of passing.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', 'https://oauth.elsewhere.example')
    const validate = await loadValidator()
    const violations = validate()
    expect(
      violations.some((v) => v.startsWith('LEGACY_DISCOVERY_HOSTS entry "app.gnubok.se"')),
    ).toBe(true)
  })

  it('reports a pinned SKV OAuth host that discovery would not reflect', async () => {
    // Direction (a): the registered callback host must be either the
    // canonical host or allowlisted, otherwise re-auth gets a wrong issuer.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', 'https://oauth.elsewhere.example')
    const validate = await loadValidator()
    const violations = validate()
    expect(
      violations.some((v) =>
        v.startsWith('NEXT_PUBLIC_SKV_OAUTH_BASE_URL host "oauth.elsewhere.example"'),
      ),
    ).toBe(true)
  })

  it('accepts the SKV pin pointing at the canonical host', async () => {
    // If Utvecklarportalen is ever re-registered on the canonical domain and
    // the allowlist is trimmed in the same PR, the invariant holds; only the
    // orphaned app.gnubok.se entry is reported until the allowlist catches up.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', CANONICAL)
    const validate = await loadValidator()
    const violations = validate()
    expect(violations.some((v) => v.startsWith('NEXT_PUBLIC_SKV_OAUTH_BASE_URL host'))).toBe(
      false,
    )
    expect(
      violations.some((v) => v.startsWith('LEGACY_DISCOVERY_HOSTS entry "app.gnubok.se"')),
    ).toBe(true)
  })

  it('accepts a pre-cutover configuration where the canonical host is the legacy host', async () => {
    // Self-hosted or pre-cutover: NEXT_PUBLIC_APP_URL still on app.gnubok.se
    // and no SKV pin set. The canonical host accounts for the allowlist entry.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', SKV_OAUTH_PIN)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', '')
    const validate = await loadValidator()
    expect(validate()).toEqual([])
  })

  it('is case-insensitive and ignores a trailing slash on the pin URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', 'https://App.Gnubok.SE/')
    const validate = await loadValidator()
    expect(validate()).toEqual([])
  })

  it('reports an unparseable NEXT_PUBLIC_SKV_OAUTH_BASE_URL instead of passing silently', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', 'not a url')
    const validate = await loadValidator()
    const violations = validate()
    expect(violations.some((v) => v.includes('not a parseable URL'))).toBe(true)
  })
})
