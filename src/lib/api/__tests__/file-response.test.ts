import { describe, it, expect } from 'vitest'
import { fileResponse, streamedBody } from '../file-response'

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

describe('streamedBody', () => {
  async function* source(log: string[], parts: string[]): AsyncGenerator<Uint8Array> {
    try {
      for (const part of parts) {
        log.push(`read ${part}`)
        yield new TextEncoder().encode(part)
      }
    } finally {
      log.push('closed')
    }
  }

  it('sends every chunk and reports the size at the end', async () => {
    const log: string[] = []
    let ended = -1
    const body = streamedBody(source(log, ['ab', 'cde']), { onEnd: (bytes) => { ended = bytes } })

    await expect(new Response(body).text()).resolves.toBe('abcde')
    expect(ended).toBe(5)
    expect(log.at(-1)).toBe('closed')
  })

  it('reads the source only as fast as the client takes it', async () => {
    const log: string[] = []
    const reader = streamedBody(source(log, ['a', 'b', 'c', 'd', 'e'])).getReader()

    await reader.read()
    // One chunk handed over, at most one queued behind it.
    expect(log.filter((l) => l.startsWith('read')).length).toBeLessThanOrEqual(2)
  })

  it('ends the source when the client goes away', async () => {
    const log: string[] = []
    let cancelledAt = -1
    const reader = streamedBody(source(log, ['a', 'b', 'c']), { onCancel: (bytes) => { cancelledAt = bytes } }).getReader()

    await reader.read()
    await reader.cancel()
    expect(log.at(-1)).toBe('closed')
    expect(cancelledAt).toBeGreaterThanOrEqual(1)
  })

  it('errors the body and reports it when the source fails part way', async () => {
    const failure = new Error('storage unavailable')
    let reported: { error: unknown; bytes: number } | null = null
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(3)
      throw failure
    }
    const body = streamedBody(failing(), { onError: (error, bytes) => { reported = { error, bytes } } })

    await expect(new Response(body).arrayBuffer()).rejects.toThrow('storage unavailable')
    expect(reported).toEqual({ error: failure, bytes: 3 })
  })
})
