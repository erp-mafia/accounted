import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('../lib/submission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/submission-service')>()
  return {
    ...actual,
    submitArsredovisning: vi.fn(),
  }
})

import { bolagsverketExtension } from '../index'
import { BolagsverketSubmissionError, submitArsredovisning } from '../lib/submission-service'

function route(method: string, path: string) {
  const found = bolagsverketExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path,
  )
  if (!found) throw new Error(`route ${method} ${path} not found`)
  return found
}

function makeCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'bolagsverket',
    requestId: 'req-1',
    supabase,
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    storage: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: {},
  } as unknown as ExtensionContext
}

const validBody = {
  fiscal_period_id: '123e4567-e89b-12d3-a456-426614174000',
  avsandare_pnr: '198001019876',
  undertecknare: {
    pnr: '198001019876',
    fornamn: 'Anna',
    efternamn: 'Svensson',
    roll: 'VD',
    epost: 'anna@example.com',
  },
}

function makePost(path: string, body: unknown = validBody): Request {
  return new Request(`http://localhost/api/extensions/ext/bolagsverket${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

interface ErrorEnvelope {
  error: { code: string; message: string; message_en?: string }
}

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL
const ORIGINAL_BV_ENV = process.env.BOLAGSVERKET_ENV

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  delete process.env.BOLAGSVERKET_ENV
})

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
  if (ORIGINAL_BV_ENV === undefined) delete process.env.BOLAGSVERKET_ENV
  else process.env.BOLAGSVERKET_ENV = ORIGINAL_BV_ENV
})

describe('POST /submissions: write-role enforcement', () => {
  it('rejects viewer members with 403 BOLAGSVERKET_FORBIDDEN', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'viewer' }, error: null }) // company_members

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('BOLAGSVERKET_FORBIDDEN')
  })

  it('rejects non-members (no role row) with 403', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // no membership

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('BOLAGSVERKET_FORBIDDEN')
  })

  it('rejects viewer members on POST /poll-events too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'viewer' }, error: null })

    const res = await route('POST', '/poll-events').handler(makePost('/poll-events', {}), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('BOLAGSVERKET_FORBIDDEN')
  })
})

describe('POST /submissions: environment validation + ceiling', () => {
  it('rejects an invalid environment setting with 400 BOLAGSVERKET_INVALID_ENVIRONMENT', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' }, error: null }) // company_members
    enqueue({ data: { value: { environment: 'banana' } }, error: null }) // settings blob

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BOLAGSVERKET_INVALID_ENVIRONMENT')
  })

  it('rejects an environment above the BOLAGSVERKET_ENV ceiling (unset → test)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' }, error: null })
    enqueue({ data: { value: { environment: 'prod' } }, error: null })

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('BOLAGSVERKET_ENV_NOT_ALLOWED')
  })

  it('allows an environment at or below the ceiling', async () => {
    process.env.BOLAGSVERKET_ENV = 'accept'
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' }, error: null })
    enqueue({ data: { value: { environment: 'test' } }, error: null })
    vi.mocked(submitArsredovisning).mockResolvedValue({
      outcome: 'uploaded',
      submissionId: 'sub-1',
      idnummer: '49679',
      sha256: 'sha',
      url: 'https://ext.bolagsverket.se/eu/49679',
      utfall: [],
    })

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: { outcome: string } }>(res as Response)
    expect(status).toBe(200)
    expect(body.data.outcome).toBe('uploaded')
    // The service got a client pinned to the validated environment.
    const deps = vi.mocked(submitArsredovisning).mock.calls[0][0]
    expect(deps.client.environment).toBe('test')
    expect(deps.appUrl).toBe('http://localhost:3000')
  })
})

describe('POST /submissions: config + error mapping', () => {
  it('fails fast with 503 BOLAGSVERKET_CONFIG_MISSING when NEXT_PUBLIC_APP_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' }, error: null })

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(503)
    expect(body.error.code).toBe('BOLAGSVERKET_CONFIG_MISSING')
  })

  it('maps BolagsverketSubmissionError to its structured code (409 double submission)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' }, error: null })
    enqueue({ data: { value: { environment: 'test' } }, error: null })
    vi.mocked(submitArsredovisning).mockRejectedValue(
      new BolagsverketSubmissionError('BOLAGSVERKET_SUBMISSION_EXISTS', 'already active', {
        submission_id: 'sub-0',
      }),
    )

    const res = await route('POST', '/submissions').handler(makePost('/submissions'), makeCtx(supabase))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('BOLAGSVERKET_SUBMISSION_EXISTS')
  })

  it('returns 400 VALIDATION_ERROR for a malformed body', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' }, error: null })

    const res = await route('POST', '/submissions').handler(
      makePost('/submissions', { fiscal_period_id: 'not-a-uuid' }),
      makeCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(res as Response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('GET /status', () => {
  it('reports resolved environment, ceiling, and env-derived certificate presence', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { value: { environment: 'test' } }, error: null })

    const res = await route('GET', '/status').handler(
      new Request('http://localhost/api/extensions/ext/bolagsverket/status'),
      makeCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<{
      data: { environment: string; environment_ceiling: string; has_certificate: boolean }
    }>(res as Response)
    expect(status).toBe(200)
    expect(body.data.environment).toBe('test')
    expect(body.data.environment_ceiling).toBe('test')
    // No BOLAGSVERKET_CLIENT_CERT/_KEY in the test env.
    expect(body.data.has_certificate).toBe(false)
  })
})
