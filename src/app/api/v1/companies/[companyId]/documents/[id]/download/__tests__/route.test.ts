/**
 * Tests for GET /api/v1/companies/:companyId/documents/:id/download.
 *
 * Covers: 401, 400 for a malformed id, 404 for a missing row, 404 for a row
 * whose stored key is not inside the company (nothing is signed), and the
 * happy path (a signed URL for the company's own key).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`download route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DOC_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OWN_KEY = `documents/${COMPANY_ID}/user-1/1767000000000_kvitto.pdf`

const createSignedUrl = vi.fn()

function row(storagePath: string) {
  return {
    id: DOC_ID,
    file_name: 'kvitto.pdf',
    mime_type: 'application/pdf',
    sha256_hash: 'a'.repeat(64),
    storage_path: storagePath,
    is_current_version: true,
  }
}

function serviceClient(document: ReturnType<typeof row> | null) {
  const { supabase } = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    document_attachments: { data: document, error: null },
  })
  Object.assign(supabase, { storage: { from: vi.fn(() => ({ createSignedUrl })) } })
  return supabase
}

function request(id = DOC_ID): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/documents/${id}/download`, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

const params = (id = DOC_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:read'],
    mode: 'live',
  })
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://storage.test/signed' }, error: null })
  mockServiceClient.mockReturnValue(serviceClient(row(OWN_KEY)))
})

describe('GET /api/v1/companies/:companyId/documents/:id/download', () => {
  it('returns 401 when the API key is not valid', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key' })
    const res = await GET(request(), params())
    expect(res.status).toBe(401)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('returns 400 for a document id that is not a UUID', async () => {
    const res = await GET(request('nope'), params('nope'))
    expect(res.status).toBe(400)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('returns 404 when the document is not in the company', async () => {
    mockServiceClient.mockReturnValue(serviceClient(null))
    const res = await GET(request(), params())
    expect(res.status).toBe(404)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('returns 404 and signs nothing for a row whose key is not inside the company', async () => {
    mockServiceClient.mockReturnValue(serviceClient(row(`documents/${OTHER_COMPANY_ID}/user-9/1767000000000_faktura.pdf`)))
    const res = await GET(request(), params())
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('signs the company key and returns the download URL', async () => {
    const res = await GET(request(), params())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({ id: DOC_ID, download_url: 'https://storage.test/signed', is_current_version: true })
    expect(createSignedUrl).toHaveBeenCalledWith(OWN_KEY, 900)
  })
})
