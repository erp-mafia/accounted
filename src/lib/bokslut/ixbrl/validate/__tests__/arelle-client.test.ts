import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateIxbrlWithArelle } from '../arelle-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('validateIxbrlWithArelle', () => {
  it('returns unavailable when no validator is configured', async () => {
    const result = await validateIxbrlWithArelle('<html />', { url: '' })
    expect(result.status).toBe('unavailable')
    expect(result.issues[0].code).toBe('ARELLE-NOT-CONFIGURED')
  })

  it('sends the exact artifact and accepts a clean validation', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { content_base64: string }
      expect(Buffer.from(body.content_base64, 'base64').toString('utf8')).toBe('<html />')
      return new Response(JSON.stringify({ ok: true, validator_version: '2.37.50', issues: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateIxbrlWithArelle('<html />', {
      url: 'https://validator.example/validate',
      token: 'secret',
    })
    expect(result.status).toBe('passed')
    expect(result.validator_version).toBe('2.37.50')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('normalizes Arelle errors into a blocking result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            issues: [{ code: 'xbrl.5.2.5.2', severity: 'error', message: 'Invalid fact' }],
          }),
        ),
      ),
    )
    const result = await validateIxbrlWithArelle('<html />', {
      url: 'https://validator.example/validate',
    })
    expect(result.status).toBe('failed')
    expect(result.issues).toEqual([
      { code: 'xbrl.5.2.5.2', severity: 'error', message: 'Invalid fact' },
    ])
  })
})
