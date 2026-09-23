/**
 * /api/health: the version field is the build identifier (commit SHA prefix)
 * when one is inlined at build, and the '1.0.0' fallback otherwise, so
 * self-hosted Docker healthchecks keep a stable value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let selectResult: { error: { code?: string; message?: string } | null } = { error: null }

vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        limit: async () => selectResult,
      }),
    }),
  }),
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

async function loadRoute() {
  vi.resetModules()
  return import('../route')
}

beforeEach(() => {
  selectResult = { error: null }
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
  vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/health', () => {
  it('reports healthy with the 1.0.0 fallback when no build id is inlined', async () => {
    const { GET } = await loadRoute()
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('healthy')
    expect(body.version).toBe('1.0.0')
    expect(typeof body.timestamp).toBe('string')
  })

  it('reports the commit SHA prefix as version when VERCEL_GIT_COMMIT_SHA is set', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abcdef1234567890abcdef1234567890abcdef12')
    const { GET } = await loadRoute()
    const body = await (await GET()).json()
    expect(body.status).toBe('healthy')
    expect(body.version).toBe('abcdef123456')
  })

  it('keeps the same version on the unhealthy path', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abcdef1234567890abcdef1234567890abcdef12')
    selectResult = { error: { code: '57P01', message: 'terminating connection' } }
    const { GET } = await loadRoute()
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.version).toBe('abcdef123456')
  })
})
