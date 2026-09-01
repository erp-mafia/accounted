import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  fetchAppReleases,
  recordAppRelease,
  resetAppReleaseGuardForTests,
  type AppReleaseRow,
} from '../app-releases'

/**
 * Program version log (BFNAR 2013:2 p. 9.16: "nya programversioner"). The
 * recorder sits on the public /api/version probe, so the properties that
 * matter are the ones that keep a hot public route cheap and unbreakable:
 * it never throws, it constructs nothing once the guard is set, and a failed
 * write is retried rather than remembered as done.
 */

function upsertSpy(result: { error: { message: string } | null } = { error: null }) {
  const upsert = vi.fn().mockResolvedValue(result)
  return { upsert, client: { from: vi.fn().mockReturnValue({ upsert }) } }
}

describe('recordAppRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAppReleaseGuardForTests()
  })

  it('records the running version, truncated to the 12-character build id', async () => {
    const { upsert, client } = upsertSpy()
    await expect(recordAppRelease(client, 'b643e6ce6d4448ccb10b985b1ff3872a77f0dd63')).resolves.toBe('b643e6ce6d44')
    expect(client.from).toHaveBeenCalledWith('app_releases')
    expect(upsert).toHaveBeenCalledWith(
      { version: 'b643e6ce6d44', source: 'runtime' },
      { onConflict: 'version', ignoreDuplicates: true },
    )
  })

  it('writes once per instance and version, then stops touching the database', async () => {
    const { upsert, client } = upsertSpy()
    await recordAppRelease(client, 'aaaaaaaaaaaa')
    await recordAppRelease(client, 'aaaaaaaaaaaa')
    await recordAppRelease(client, 'aaaaaaaaaaaa')
    expect(upsert).toHaveBeenCalledTimes(1)

    // A different build is a different row: the guard is per version.
    await recordAppRelease(client, 'bbbbbbbbbbbb')
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('never constructs the service client once the guard is set', async () => {
    const { client } = upsertSpy()
    const factory = vi.fn().mockReturnValue(client)
    await recordAppRelease(factory, 'cccccccccccc')
    expect(factory).toHaveBeenCalledTimes(1)
    await recordAppRelease(factory, 'cccccccccccc')
    // The point of the factory form: /api/version is polled constantly and
    // must not build a Supabase client per probe.
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('swallows a throwing client factory: a missing service key must not break the version probe', async () => {
    const factory = vi.fn(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
    })
    await expect(recordAppRelease(factory, 'dddddddddddd')).resolves.toBe('dddddddddddd')
  })

  it('retries on the next request when the write failed, rather than remembering it as done', async () => {
    const failing = upsertSpy({ error: { message: 'permission denied' } })
    await recordAppRelease(failing.client, 'eeeeeeeeeeee')
    await recordAppRelease(failing.client, 'eeeeeeeeeeee')
    expect(failing.upsert).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the build id is unknown (local dev, self-hosted without VERCEL_GIT_COMMIT_SHA)', async () => {
    const { upsert, client } = upsertSpy()
    await expect(recordAppRelease(client, null)).resolves.toBeNull()
    await expect(recordAppRelease(client, '')).resolves.toBeNull()
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('fetchAppReleases', () => {
  const rows: AppReleaseRow[] = [
    { version: 'aaaaaaaaaaaa', first_seen_at: '2026-03-01T08:00:00.000Z', source: 'runtime' },
  ]

  function selectClient(result: { data: AppReleaseRow[] | null; error: { message: string } | null }) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue(result),
    }
    return { chain, client: { from: vi.fn().mockReturnValue(chain) } }
  }

  it('windows on first_seen_at and returns the versions oldest first', async () => {
    const { chain, client } = selectClient({ data: rows, error: null })
    const out = await fetchAppReleases(client, { fromTs: '2026-01-01T00:00:00.000Z', toTs: '2026-12-31T23:59:59.999Z' })
    expect(out).toEqual(rows)
    expect(chain.gte).toHaveBeenCalledWith('first_seen_at', '2026-01-01T00:00:00.000Z')
    expect(chain.lte).toHaveBeenCalledWith('first_seen_at', '2026-12-31T23:59:59.999Z')
    expect(chain.order).toHaveBeenCalledWith('first_seen_at', { ascending: true })
  })

  it('throws on a read failure: a report that silently drops the version log is not a behandlingshistorik', async () => {
    const { client } = selectClient({ data: null, error: { message: 'relation does not exist' } })
    await expect(
      fetchAppReleases(client, { fromTs: '2026-01-01T00:00:00.000Z', toTs: '2026-12-31T23:59:59.999Z' }),
    ).rejects.toThrow('Failed to fetch app releases: relation does not exist')
  })
})
