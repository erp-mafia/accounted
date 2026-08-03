/**
 * Tests for the pack sync cron.
 *
 * The route itself is thin; what matters is that it fails CLOSED. A cron that
 * reports success while the catalogue failed to load would let a broken deploy
 * sit unnoticed until someone opened the template picker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

const syncSystemPacks = vi.fn()
vi.mock('@/lib/packs/sync', () => ({
  syncSystemPacks: (...args: unknown[]) => syncSystemPacks(...args),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ __service: true })),
}))

const OK_RESULT = {
  inserted: ['a'], updated: ['b'], unchanged: ['c', 'd'], retired: [], errors: [], dryRun: false,
}

async function callRoute() {
  const { GET } = await import('../route')
  return GET(new Request('https://example.test/api/settings/booking-templates/sync/cron') as never, {} as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
})

describe('GET /api/settings/booking-templates/sync/cron', () => {
  it('returns the sync counts on success', async () => {
    syncSystemPacks.mockResolvedValueOnce(OK_RESULT)

    const res = await callRoute()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.data).toMatchObject({ inserted: 1, updated: 1, unchanged: 2, retired: 0 })
  })

  it('names the retired slugs, so a retirement is never silent', async () => {
    syncSystemPacks.mockResolvedValueOnce({ ...OK_RESULT, retired: ['gammal-mall'] })

    const body = await (await callRoute()).json()
    expect(body.data.retired_slugs).toEqual(['gammal-mall'])
  })

  it('fails when the catalogue is invalid instead of reporting success', async () => {
    // syncSystemPacks writes nothing in this case, so the previous catalogue
    // stands. The cron must still go red: a silent 200 would hide a bad deploy.
    syncSystemPacks.mockResolvedValueOnce({
      ...OK_RESULT,
      inserted: [], updated: [], unchanged: [],
      errors: ['packs/x.yaml: meta.slug: slug must be lowercase kebab-case'],
    })

    const res = await callRoute()
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it('fails when Supabase configuration is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const res = await callRoute()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(syncSystemPacks).not.toHaveBeenCalled()
  })
})
