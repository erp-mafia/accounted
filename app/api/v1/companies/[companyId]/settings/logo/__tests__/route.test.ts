import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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

import { createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import { LOGO_UPLOAD_MAX_BYTES } from '@/lib/invoices/branding-constants'
import { POST as createUploadUrl } from '../upload-url/route'
import { POST as completeUpload } from '../complete/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UPLOAD_ID = '12345678-1234-4123-8123-123456789abc'
const STORAGE_PATH = `${COMPANY_ID}/logo-upload-${UPLOAD_ID}.png`

type MockResult = { data?: unknown; error?: unknown }

function makeClient(
  byTable: Record<string, MockResult | MockResult[]> = {},
  storageOverrides: Record<string, unknown> = {},
) {
  const events: string[] = []
  const queues = new Map<string, MockResult[]>()
  for (const [table, value] of Object.entries(byTable)) {
    queues.set(table, Array.isArray(value) ? [...value] : [value])
  }

  const buildChain = (table: string): unknown => new Proxy({}, {
    get(_target, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => void) => {
          events.push(`${table}.result`)
          const queue = queues.get(table)
          const result = queue && queue.length > 1
            ? queue.shift()!
            : (queue?.[0] ?? { data: null, error: null })
          resolve(result)
        }
      }
      return (..._args: unknown[]) => {
        events.push(`${table}.${String(property)}`)
        return buildChain(table)
      }
    },
  })

  const bucket = {
    createSignedUploadUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://storage.example.com/upload?token=signed' },
      error: null,
    }),
    info: vi.fn().mockResolvedValue({
      data: { size: 1024, contentType: 'image/png' },
      error: null,
    }),
    getPublicUrl: vi.fn().mockReturnValue({
      data: { publicUrl: `https://cdn.example.com/logos/${STORAGE_PATH}` },
    }),
    list: vi.fn().mockImplementation(async () => {
      events.push('storage.list')
      return { data: [], error: null }
    }),
    remove: vi.fn().mockResolvedValue({ data: [], error: null }),
    ...storageOverrides,
  }

  return {
    client: {
      from: vi.fn((table: string) => buildChain(table)),
      storage: { from: vi.fn(() => bucket) },
    },
    bucket,
    events,
  }
}

function membershipResult(): MockResult {
  return { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
}

function request(path: string, body: unknown, withAuth = true): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (withAuth) headers.set('Authorization', 'Bearer fixture-not-a-real-key')
  return new Request(`https://app.example.com${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function params() {
  return { params: Promise.resolve({ companyId: COMPANY_ID }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['companies:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/settings/logo/upload-url', () => {
  it('creates a company-scoped signed PUT URL', async () => {
    const { client, bucket } = makeClient({ company_members: membershipResult() })
    mockServiceClient.mockReturnValue(client)

    const response = await createUploadUrl(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/upload-url`, {
        mime_type: 'image/png',
      }),
      params(),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      upload_url: 'https://storage.example.com/upload?token=signed',
      method: 'PUT',
      mime_type: 'image/png',
      expires_in_seconds: 7200,
      complete_endpoint: `/api/v1/companies/${COMPANY_ID}/settings/logo/complete`,
    })
    expect(body.data.storage_path).toMatch(
      new RegExp(`^${COMPANY_ID}/logo-upload-[0-9a-f-]{36}\\.png$`),
    )
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(body.data.storage_path)
  })

  it('requires authentication and companies:write scope', async () => {
    const unauthenticated = await createUploadUrl(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/upload-url`, {
        mime_type: 'image/png',
      }, false),
      params(),
    )
    expect(unauthenticated.status).toBe(401)

    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['companies:read'],
      mode: 'live',
    })
    const { client } = makeClient()
    mockServiceClient.mockReturnValue(client)
    const insufficientScope = await createUploadUrl(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/upload-url`, {
        mime_type: 'image/png',
      }),
      params(),
    )
    expect(insufficientScope.status).toBe(403)
  })

  it('rejects unsupported MIME types before creating a URL', async () => {
    const { client, bucket } = makeClient({ company_members: membershipResult() })
    mockServiceClient.mockReturnValue(client)

    const response = await createUploadUrl(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/upload-url`, {
        mime_type: 'application/pdf',
      }),
      params(),
    )

    expect(response.status).toBe(400)
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('returns 404 without revealing a company outside the caller membership', async () => {
    const { client, bucket } = makeClient({
      company_members: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)

    const response = await createUploadUrl(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/upload-url`, {
        mime_type: 'image/png',
      }),
      params(),
    )

    expect(response.status).toBe(404)
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('returns a stable error when signing fails', async () => {
    const { client } = makeClient(
      { company_members: membershipResult() },
      {
        createSignedUploadUrl: vi.fn().mockResolvedValue({
          data: null,
          error: new Error('storage unavailable'),
        }),
      },
    )
    mockServiceClient.mockReturnValue(client)

    const response = await createUploadUrl(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/upload-url`, {
        mime_type: 'image/png',
      }),
      params(),
    )
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error.code).toBe('LOGO_UPLOAD_URL_FAILED')
  })
})

describe('POST /api/v1/companies/:companyId/settings/logo/complete', () => {
  it('rejects cross-company paths before accessing storage', async () => {
    const { client, bucket } = makeClient({ company_members: membershipResult() })
    mockServiceClient.mockReturnValue(client)

    const response = await completeUpload(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/complete`, {
        storage_path: `${OTHER_COMPANY_ID}/logo-upload-${UPLOAD_ID}.png`,
      }),
      params(),
    )

    expect(response.status).toBe(400)
    expect(bucket.info).not.toHaveBeenCalled()
  })

  it('returns 404 when the uploaded object does not exist', async () => {
    const { client } = makeClient(
      { company_members: membershipResult() },
      {
        info: vi.fn().mockResolvedValue({
          data: null,
          error: { statusCode: '404', message: 'not found' },
        }),
      },
    )
    mockServiceClient.mockReturnValue(client)

    const response = await completeUpload(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/complete`, {
        storage_path: STORAGE_PATH,
      }),
      params(),
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('LOGO_UPLOAD_NOT_FOUND')
  })

  it('rejects oversized and mismatched stored objects', async () => {
    const oversized = makeClient(
      { company_members: membershipResult() },
      {
        info: vi.fn().mockResolvedValue({
          data: { size: LOGO_UPLOAD_MAX_BYTES + 1, contentType: 'image/png' },
          error: null,
        }),
      },
    )
    mockServiceClient.mockReturnValue(oversized.client)
    const oversizedResponse = await completeUpload(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/complete`, {
        storage_path: STORAGE_PATH,
      }),
      params(),
    )
    expect(oversizedResponse.status).toBe(400)
    expect((await oversizedResponse.json()).error.code).toBe('LOGO_UPLOAD_TOO_LARGE')

    const mismatched = makeClient(
      { company_members: membershipResult() },
      {
        info: vi.fn().mockResolvedValue({
          data: { size: 1024, contentType: 'image/jpeg' },
          error: null,
        }),
      },
    )
    mockServiceClient.mockReturnValue(mismatched.client)
    const mismatchedResponse = await completeUpload(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/complete`, {
        storage_path: STORAGE_PATH,
      }),
      params(),
    )
    expect(mismatchedResponse.status).toBe(400)
    expect((await mismatchedResponse.json()).error.code).toBe('LOGO_UPLOAD_UNSUPPORTED_TYPE')
  })

  it('keeps the previous logo when the settings update fails', async () => {
    const { client, bucket } = makeClient({
      company_members: membershipResult(),
      company_settings: { data: null, error: new Error('database unavailable') },
    })
    mockServiceClient.mockReturnValue(client)

    const response = await completeUpload(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/complete`, {
        storage_path: STORAGE_PATH,
      }),
      params(),
    )
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error.code).toBe('LOGO_ACTIVATION_FAILED')
    expect(bucket.list).not.toHaveBeenCalled()
    expect(bucket.remove).not.toHaveBeenCalled()
  })

  it('activates the new logo before cleaning up superseded objects', async () => {
    const { client, bucket, events } = makeClient(
      {
        company_members: membershipResult(),
        company_settings: { data: { company_id: COMPANY_ID }, error: null },
      },
      {
        list: vi.fn().mockImplementation(async () => {
          events.push('storage.list')
          return {
            data: [
              { name: `logo-upload-${UPLOAD_ID}.png` },
              { name: 'logo-upload-old.png' },
            ],
            error: null,
          }
        }),
      },
    )
    mockServiceClient.mockReturnValue(client)

    const response = await completeUpload(
      request(`/api/v1/companies/${COMPANY_ID}/settings/logo/complete`, {
        storage_path: STORAGE_PATH,
      }),
      params(),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      logo_url: `https://cdn.example.com/logos/${STORAGE_PATH}`,
      storage_path: STORAGE_PATH,
    })
    expect(events.indexOf('company_settings.result')).toBeLessThan(events.indexOf('storage.list'))
    expect(bucket.remove).toHaveBeenCalledWith([`${COMPANY_ID}/logo-upload-old.png`])
  })
})
