import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
