import { describe, it, expect, vi, afterEach } from 'vitest'
import { revokeToken } from '../google-oauth'

afterEach(() => vi.unstubAllGlobals())

describe('cloud-backup revokeToken', () => {
  it('sends the refresh token in the body, never in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await revokeToken('refresh-secret')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/revoke')
    expect(url).not.toContain('refresh-secret')
    expect(String(init.body)).toBe('token=refresh-secret')
  })

  it('never throws, so a disconnect completes when Google does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(revokeToken('t')).resolves.toBeUndefined()
  })
})
