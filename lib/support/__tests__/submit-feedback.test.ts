import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { submitFeedback } from '@/lib/support/submit-feedback'

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetchOk() {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  it('posts subject and message to the contact endpoint', async () => {
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ subject: 'Hjälpsida', message: 'Hjälp tack' })

    expect(result.ok).toBe(true)
    expect(result.channels).toEqual(['email'])
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/support/contact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subject: 'Hjälpsida', message: 'Hjälp tack' }),
      })
    )
  })

  it('omits subject when not provided', async () => {
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ message: 'plain' })

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/support/contact',
      expect.objectContaining({
        body: JSON.stringify({ message: 'plain' }),
      })
    )
  })

  it('returns failure with server error message when the endpoint rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Mailtjänsten är inte konfigurerad' }),
      })
    )

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channels).toEqual([])
    expect(result.error).toBe('Mailtjänsten är inte konfigurerad')
  })

  it('returns failure when fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')))

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channels).toEqual([])
    expect(result.error).toBe('Network down')
  })
})
