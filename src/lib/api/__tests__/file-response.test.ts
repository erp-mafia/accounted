import { describe, it, expect } from 'vitest'
import { fileResponse } from '../file-response'

describe('fileResponse', () => {
  it('answers 200 with the type and an RFC 6266 attachment header', async () => {
    const res = fileResponse('hej', { filename: 'rapport.csv', contentType: 'text/csv; charset=utf-8' })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="rapport.csv"; filename*=UTF-8''rapport.csv`)
    expect(res.headers.get('Cache-Control')).toBeNull()
    await expect(res.text()).resolves.toBe('hej')
  })

  it('carries a name a raw header could not: above U+00FF, NFD and a quote', () => {
    // A raw `filename="${name}"` throws a TypeError in undici for the first
    // two and breaks the quoted-string on the third.
    const name = 'Bal̈ansräkning – "Acme".pdf'
    const res = fileResponse(new Uint8Array([1]), { filename: name, contentType: 'application/pdf', disposition: 'inline' })

    const header = res.headers.get('Content-Disposition')!
    expect(header.startsWith('inline; filename="')).toBe(true)
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(name.normalize('NFC'))}`)
  })

  it('adds Cache-Control and further headers only when given', () => {
    const res = fileResponse('x', {
      filename: 'a.zip',
      contentType: 'application/zip',
      cacheControl: 'private, no-store',
      headers: { 'X-Request-Id': 'req-1' },
    })

    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('X-Request-Id')).toBe('req-1')
  })
})
