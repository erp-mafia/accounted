import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readBodyWithCap,
  resolveUpstreamStorageUrl,
  toSameOriginStorageUrl,
} from '../storage-proxy'

const SUPABASE = 'https://pwxtzglxptnnvjrpixpg.supabase.co'
const APP = 'https://app.accounted.se'
const UPLOAD_URL = `${SUPABASE}/storage/v1/object/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=eyJ.sig`
const DOWNLOAD_URL = `${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig&download=`

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('toSameOriginStorageUrl', () => {
  it('moves a signed upload URL onto the app origin, keeping path encoding and the token', () => {
    expect(toSameOriginStorageUrl(UPLOAD_URL)).toBe(
      `${APP}/api/storage/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=eyJ.sig`,
    )
  })

  it('moves a signed download URL onto the app origin with every query parameter', () => {
    expect(toSameOriginStorageUrl(DOWNLOAD_URL)).toBe(
      `${APP}/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig&download=`,
    )
  })

  it('tolerates a trailing slash on the app URL', () => {
    expect(toSameOriginStorageUrl(DOWNLOAD_URL, `${APP}/`)).toMatch(
      new RegExp(`^${APP}/api/storage/sign/`),
    )
  })

  it('leaves the URL alone when the app has no public URL (self-host without NEXT_PUBLIC_APP_URL)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(toSameOriginStorageUrl(UPLOAD_URL)).toBe(UPLOAD_URL)
    expect(toSameOriginStorageUrl(UPLOAD_URL, undefined)).toBe(UPLOAD_URL)
  })

  it('leaves URLs on other hosts, other buckets, unsigned paths and token-less links alone', () => {
    expect(toSameOriginStorageUrl('https://storage.example/upload?token=signed')).toBe(
      'https://storage.example/upload?token=signed',
    )
    const otherBucket = `${SUPABASE}/storage/v1/object/sign/avatars/a.png?token=t`
    expect(toSameOriginStorageUrl(otherBucket)).toBe(otherBucket)
    const publicObject = `${SUPABASE}/storage/v1/object/public/documents/a.pdf`
    expect(toSameOriginStorageUrl(publicObject)).toBe(publicObject)
    const noToken = `${SUPABASE}/storage/v1/object/sign/documents/a.pdf`
    expect(toSameOriginStorageUrl(noToken)).toBe(noToken)
    expect(toSameOriginStorageUrl('not a url')).toBe('not a url')
  })
})

describe('resolveUpstreamStorageUrl', () => {
  it('rebuilds the upstream signed URL for upload and download paths', () => {
    expect(
      resolveUpstreamStorageUrl(
        'upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf',
        new URLSearchParams('token=eyJ.sig'),
      ),
    ).toEqual({
      ok: true,
      url: `${SUPABASE}/storage/v1/object/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=eyJ.sig`,
    })
    expect(
      resolveUpstreamStorageUrl(
        'sign/documents/co-1/user-1/kvitto.pdf',
        new URLSearchParams('token=eyJ.sig&download='),
      ),
    ).toEqual({
      ok: true,
      url: `${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig&download=`,
    })
  })

  it('fails closed on anything that is not a signed documents-bucket object path', () => {
    const token = new URLSearchParams('token=t')
    expect(resolveUpstreamStorageUrl('public/documents/a.pdf', token)).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('sign/avatars/a.png', token)).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('sign/documents/', token)).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('sign/documents/../bucket/x', token)).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('list/documents', token)).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
  })

  it('rejects dot segments in every spelling the URL parser would normalise away', () => {
    const token = new URLSearchParams('token=t')
    for (const evil of [
      'sign/documents/%2e%2e/avatars/x',
      'sign/documents/.%2e/avatars/x',
      'sign/documents/%2e./avatars/x',
      'sign/documents/%2E%2E/avatars/x',
      'sign/documents/a/../../avatars/x',
      'sign/documents/./x',
      'sign/documents/a//x',
      'sign/documents/a%5c..%5cavatars/x',
      'sign/documents/a\\..\\avatars/x',
      'sign/documents/a%2f..%2favatars/x',
      'sign/documents/%zz/x',
      'upload/sign/documents/%2e%2e/avatars/x',
    ]) {
      expect(resolveUpstreamStorageUrl(evil, token), evil).toEqual({
        ok: false,
        reason: 'unsupported_path',
      })
    }
  })

  it('still accepts real keys with spaces, non-ASCII and dots inside names', () => {
    const token = new URLSearchParams('token=t')
    const resolved = resolveUpstreamStorageUrl(
      'sign/documents/co-1/user-1/faktura%20maj%20%C3%A5r.2026.pdf',
      token,
    )
    expect(resolved.ok).toBe(true)
  })

  it('requires the signed token', () => {
    expect(resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams())).toEqual({
      ok: false,
      reason: 'missing_token',
    })
  })

  it('reports an unconfigured Storage host instead of guessing', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    expect(
      resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams('token=t')),
    ).toEqual({ ok: false, reason: 'storage_unconfigured' })
  })
})

describe('readBodyWithCap', () => {
  function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
  }

  it('concatenates a body under the cap', async () => {
    const out = await readBodyWithCap(
      stream([new TextEncoder().encode('%PDF'), new TextEncoder().encode('-1.4')]),
      100,
    )
    expect(out && new TextDecoder().decode(out)).toBe('%PDF-1.4')
  })

  it('returns null as soon as the running total passes the cap, without draining the rest', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
      },
    })

    const out = await readBodyWithCap(endless, 4096)

    expect(out).toBeNull()
    expect(pulled).toBeLessThan(10)
  })

  it('treats a missing body as empty', async () => {
    expect((await readBodyWithCap(null, 10))?.byteLength).toBe(0)
  })
})
