import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const { supabase, mockResult } = createMockSupabase()
const createSignedUploadUrl = vi.fn()
const auth = {
  userId: 'user-1', companyId: COMPANY_ID, apiKeyId: 'ak_1',
  scopes: ['bookkeeping:write'], mode: 'live',
}

function callRoute(body: unknown = { filename: 'bok.se', size: 1024 }, authenticated = true) {
  return POST(new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/imports/sie/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {}),
    },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ companyId: COMPANY_ID }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(validateApiKey).mockResolvedValue(auth as Awaited<ReturnType<typeof validateApiKey>>)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
  mockResult({ data: { company_id: COMPANY_ID, role: 'owner' }, error: null })
  supabase.storage.from.mockReturnValue({ createSignedUploadUrl } as never)
  createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
})

describe('POST /imports/sie/upload', () => {
  it('requires authentication before reserving storage', async () => {
    expect((await callRoute(undefined, false)).status).toBe(401)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('requires bookkeeping write scope', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({ ...auth, scopes: ['bookkeeping:read'] } as never)
    expect((await callRoute()).status).toBe(403)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('hides companies the caller cannot access', async () => {
    mockResult({ data: null, error: null })
    expect((await callRoute()).status).toBe(404)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses a viewer even with write scope', async () => {
    mockResult({ data: { company_id: COMPANY_ID, role: 'viewer' }, error: null })
    expect((await callRoute()).status).toBe(403)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('does not issue a real upload URL for a test key', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({ ...auth, mode: 'test' } as never)
    expect((await callRoute()).status).toBe(403)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it.each([
    { filename: 'bok.pdf', size: 1024 },
    { filename: 'x'.repeat(256) + '.se', size: 1024 },
    { filename: 'bok.se', size: 0 },
    { filename: 'bok.se', size: -1 },
    { filename: 'bok.se', size: 1.5 },
    { filename: 'bok.se', size: 50 * 1024 * 1024 + 1 },
    { filename: 'bok.se' },
  ])('rejects invalid input before storage: %j', async body => {
    expect((await callRoute(body)).status).toBe(400)
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it.each(['bok.se', 'VISMA.SIE', 'bokio.si'])('reserves a unique company-owned, non-overwriting path for %s', async filename => {
    const response = await callRoute({ filename, size: 50 * 1024 * 1024 })
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data).toEqual({
      storagePath: expect.stringMatching(new RegExp(`^${COMPANY_ID}/sie-intake/[0-9a-f-]{36}\\.se$`)),
      uploadUrl: 'https://storage.example/signed', filename,
    })
    expect(supabase.storage.from).toHaveBeenCalledWith('sie-files')
    expect(createSignedUploadUrl).toHaveBeenCalledWith(data.storagePath, { upsert: false })
    const retry = await callRoute({ filename, size: 1024 })
    expect((await retry.json()).data.storagePath).not.toBe(data.storagePath)
  })

  it('returns an error envelope when storage reservation fails', async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: new Error('Storage unavailable') })
    const response = await callRoute()
    expect(response.status).toBe(500)
    expect((await response.json()).data).toBeUndefined()
  })
})
