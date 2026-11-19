import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deletePostHogPerson } from '../delete-person'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_secret')
  vi.stubEnv('POSTHOG_PROJECT_ID', '12345')
  vi.stubEnv('POSTHOG_APP_HOST', '')
})

afterEach(() => vi.unstubAllEnvs())

describe('deletePostHogPerson', () => {
  it('asks PostHog to delete the person with their events and recordings', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    expect(await deletePostHogPerson('user-1', fetchImpl as never)).toBe('deleted')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://eu.posthog.com/api/projects/12345/persons/bulk_delete/')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer phx_secret')
    expect(JSON.parse(init.body as string)).toEqual({ distinct_ids: ['user-1'], delete_events: true, delete_recordings: true })
  })

  it('skips without a key or project id, and on a self-host', async () => {
    const fetchImpl = vi.fn()
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '')
    expect(await deletePostHogPerson('user-1', fetchImpl as never)).toBe('skipped')
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_secret')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(await deletePostHogPerson('user-1', fetchImpl as never)).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never throws: a refusal or a network error is reported as failed', async () => {
    expect(await deletePostHogPerson('user-1', (async () => new Response(null, { status: 403 })) as never)).toBe('failed')
    expect(
      await deletePostHogPerson('user-1', (async () => {
        throw new Error('offline')
      }) as never),
    ).toBe('failed')
  })
})
