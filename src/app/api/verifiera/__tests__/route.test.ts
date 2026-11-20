import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const service = vi.hoisted(() => ({ marker: 'service' }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => service }))
const verify = vi.hoisted(() => vi.fn())
vi.mock('@/lib/signing/verify', () => ({ verifySignedFile: verify }))

import { POST } from '../route'

const HASH = 'cd'.repeat(32)
let ipCounter = 0
const post = (body: unknown, ip?: string) =>
  createMockRequest('/api/verifiera', { method: 'POST', body, headers: { 'x-forwarded-for': ip ?? `198.51.100.${(ipCounter += 1)}` } })

beforeEach(() => {
  vi.clearAllMocks()
  verify.mockResolvedValue(null)
})

describe('POST /api/verifiera', () => {
  it('is 400 for anything but a SHA-256, and looks nothing up', async () => {
    expect((await POST(post({ sha256: 'nope' }))).status).toBe(400)
    expect((await POST(post({ sha256: HASH, extra: 1 }))).status).toBe(400)
    expect((await POST(post({}))).status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })

  it('answers found false when no completed signing matches, never cached', async () => {
    const res = await POST(post({ sha256: HASH.toUpperCase() }))
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await parseJsonResponse(res)).toEqual({ status: 200, body: { data: { found: false } } })
    expect(verify).toHaveBeenCalledWith(service, HASH)
  })

  it('answers what the signed copy prints when one matches', async () => {
    const signing = { match: 'signed_copy', title: 'Hyresavtal', company_name: 'Bolaget AB', completed_at: '2026-10-24T12:30:00.000Z', signers: [] }
    verify.mockResolvedValue(signing)
    expect(await parseJsonResponse(await POST(post({ sha256: HASH })))).toEqual({ status: 200, body: { data: { found: true, ...signing } } })
  })

  it('is 429 past 30 checks from one address in ten minutes', async () => {
    for (let i = 0; i < 30; i++) expect((await POST(post({ sha256: HASH }, '203.0.113.77'))).status).toBe(200)
    expect((await POST(post({ sha256: HASH }, '203.0.113.77'))).status).toBe(429)
    expect((await POST(post({ sha256: HASH }, '203.0.113.78'))).status).toBe(200)
  })

  it('answers 500 in the error envelope when the lookup fails', async () => {
    verify.mockRejectedValue(new Error('db down'))
    expect((await POST(post({ sha256: HASH }))).status).toBe(500)
  })
})
