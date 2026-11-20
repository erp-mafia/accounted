import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readBodyWithCap,
  resolveUpstreamStorageUrl,
  storageTokenFromAuthorization,
  toSameOriginStorageRequest,
} from '../storage-proxy'

const SUPABASE = 'https://pwxtzglxptnnvjrpixpg.supabase.co'
const APP = 'https://app.accounted.se'
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJkb2N1bWVudHMveCJ9.c2ln'
const UPLOAD_URL = `${SUPABASE}/storage/v1/object/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=${TOKEN}`
const DOWNLOAD_URL = `${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=${TOKEN}&download=`

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('toSameOriginStorageRequest', () => {
  it('moves a signed upload URL onto the app origin and the token into the Authorization header', () => {
    expect(toSameOriginStorageRequest(UPLOAD_URL)).toEqual({
      url: `${APP}/api/storage/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  })

  it('keeps every other query parameter of a signed download URL, as Storage spelled it', () => {
    expect(toSameOriginStorageRequest(DOWNLOAD_URL)).toEqual({
      url: `${APP}/api/storage/sign/documents/co-1/user-1/kvitto.pdf?download=`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    const named = `${SUPABASE}/storage/v1/object/sign/documents/co-1/a.eml?download=brev%20maj.eml&token=${TOKEN}`
    expect(toSameOriginStorageRequest(named).url).toBe(
      `${APP}/api/storage/sign/documents/co-1/a.eml?download=brev%20maj.eml`,
    )
  })

  it('never leaves the token anywhere in the rewritten URL', () => {
    for (const signed of [UPLOAD_URL, DOWNLOAD_URL]) {
      const { url } = toSameOriginStorageRequest(signed)
      expect(url).not.toContain(TOKEN)
      expect(new URL(url).searchParams.has('token')).toBe(false)
    }
  })

  it('tolerates a trailing slash on the app URL', () => {
    expect(toSameOriginStorageRequest(DOWNLOAD_URL, `${APP}/`).url).toMatch(
      new RegExp(`^${APP}/api/storage/sign/`),
    )
  })

  it('hands the raw signed URL back with no headers when the app has no public URL (self-host without NEXT_PUBLIC_APP_URL)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(toSameOriginStorageRequest(UPLOAD_URL)).toEqual({ url: UPLOAD_URL, headers: {} })
    expect(toSameOriginStorageRequest(UPLOAD_URL, undefined)).toEqual({ url: UPLOAD_URL, headers: {} })
  })

  it('leaves URLs on other hosts, other buckets, unsigned paths and token-less links alone, with no headers', () => {
    const otherBucket = `${SUPABASE}/storage/v1/object/sign/avatars/a.png?token=t`
    const publicObject = `${SUPABASE}/storage/v1/object/public/documents/a.pdf`
    const noToken = `${SUPABASE}/storage/v1/object/sign/documents/a.pdf`
    for (const url of ['https://storage.example/upload?token=signed', otherBucket, publicObject, noToken, 'not a url']) {
      expect(toSameOriginStorageRequest(url), url).toEqual({ url, headers: {} })
    }
  })

  it('round-trips: the proxy rebuilds the signed URL it was made from', () => {
    for (const signed of [UPLOAD_URL, DOWNLOAD_URL]) {
      const { url, headers } = toSameOriginStorageRequest(signed)
      const proxied = new URL(url)
      const resolved = resolveUpstreamStorageUrl(
        proxied.pathname.slice('/api/storage/'.length),
        proxied.searchParams,
        storageTokenFromAuthorization(headers.Authorization),
      )
      expect(resolved).toEqual({ ok: true, url: signed })
    }
  })
})

describe('storageTokenFromAuthorization', () => {
  it('reads the token of a Bearer credential, whatever the case of the scheme', () => {
    expect(storageTokenFromAuthorization(`Bearer ${TOKEN}`)).toBe(TOKEN)
    expect(storageTokenFromAuthorization(`bearer ${TOKEN}`)).toBe(TOKEN)
    expect(storageTokenFromAuthorization(`  Bearer   ${TOKEN} `)).toBe(TOKEN)
  })

  it('answers null for no header, another scheme or a malformed value', () => {
    expect(storageTokenFromAuthorization(null)).toBeNull()
    expect(storageTokenFromAuthorization(undefined)).toBeNull()
    expect(storageTokenFromAuthorization('')).toBeNull()
    expect(storageTokenFromAuthorization('Bearer')).toBeNull()
    expect(storageTokenFromAuthorization('Bearer ')).toBeNull()
    expect(storageTokenFromAuthorization(`Basic ${TOKEN}`)).toBeNull()
    expect(storageTokenFromAuthorization(TOKEN)).toBeNull()
    expect(storageTokenFromAuthorization(`Bearer ${TOKEN} extra`)).toBeNull()
  })
})

describe('resolveUpstreamStorageUrl', () => {
  it('rebuilds the upstream signed URL for upload and download paths from the header token', () => {
    expect(
      resolveUpstreamStorageUrl(
        'upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf',
        new URLSearchParams(),
        'eyJ.sig',
      ),
    ).toEqual({
      ok: true,
      url: `${SUPABASE}/storage/v1/object/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=eyJ.sig`,
    })
    expect(
      resolveUpstreamStorageUrl(
        'sign/documents/co-1/user-1/kvitto.pdf',
        new URLSearchParams('download='),
        'eyJ.sig',
      ),
    ).toEqual({
      ok: true,
      url: `${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig&download=`,
    })
  })

  it('fails closed on anything that is not a signed documents-bucket object path', () => {
    const none = new URLSearchParams()
    expect(resolveUpstreamStorageUrl('public/documents/a.pdf', none, 't')).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('sign/avatars/a.png', none, 't')).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('sign/documents/', none, 't')).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('sign/documents/../bucket/x', none, 't')).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
    expect(resolveUpstreamStorageUrl('list/documents', none, 't')).toEqual({
      ok: false,
      reason: 'unsupported_path',
    })
  })

  it('rejects dot segments in every spelling the URL parser would normalise away', () => {
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
      expect(resolveUpstreamStorageUrl(evil, new URLSearchParams(), 't'), evil).toEqual({
        ok: false,
        reason: 'unsupported_path',
      })
    }
  })

  it('still accepts real keys with spaces, non-ASCII and dots inside names', () => {
    const resolved = resolveUpstreamStorageUrl(
      'sign/documents/co-1/user-1/faktura%20maj%20%C3%A5r.2026.pdf',
      new URLSearchParams(),
      't',
    )
    expect(resolved.ok).toBe(true)
  })

  it('requires the signed token', () => {
    expect(resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams(), null)).toEqual({
      ok: false,
      reason: 'missing_token',
    })
    expect(resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams(), '')).toEqual({
      ok: false,
      reason: 'missing_token',
    })
  })

  it('refuses a token in the query string, with or without one in the header', () => {
    for (const headerToken of [null, 'eyJ.sig']) {
      expect(
        resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams('token=eyJ.sig'), headerToken),
      ).toEqual({ ok: false, reason: 'token_in_url' })
      // An empty value is still the parameter.
      expect(
        resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams('download=&token='), headerToken),
      ).toEqual({ ok: false, reason: 'token_in_url' })
    }
  })

  it('refuses one of the app\'s own credentials sent as the token, so it is never relayed to Storage', () => {
    for (const credential of ['gnubok_sk_abc123', 'gnubok_sk_test_abc123', 'gnubok_rt_abc123']) {
      expect(
        resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams(), credential),
      ).toEqual({ ok: false, reason: 'api_key_as_token' })
    }
  })

  it('reports an unconfigured Storage host instead of guessing', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    expect(
      resolveUpstreamStorageUrl('sign/documents/a.pdf', new URLSearchParams(), 't'),
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
