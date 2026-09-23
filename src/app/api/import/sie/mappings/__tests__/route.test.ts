/**
 * Tests for GET/POST/PUT/DELETE /api/import/sie/mappings.
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, 403 viewer, validation (400), and happy paths.
 *
 * The route has no 404 path: PUT upserts (a missing mapping is created, not
 * rejected) and DELETE is idempotent (removing an unknown source account is a
 * no-op, not a miss). The DELETE test below pins that contract.
 *
 * The PUT column-level tests use createRecordingSupabase() instead of the
 * shared queued mock: the queued mock is a Proxy that discards call arguments,
 * so it cannot see which columns the route actually writes, which is exactly
 * what regressed here (source_name silently dropped from the upsert).
 *
 * The POST tests do the same one level deeper. Mocking saveMappings only
 * proves which value the route passed as the second positional argument; it
 * cannot show which COLUMN that value ends up in. That is what hid the bug
 * this file used to pin: the route passed user.id where saveMappings expects
 * companyId, and both are strings, so nothing complained. One POST test
 * therefore runs the real saveMappings against a recording Supabase double and
 * asserts on the row it upserts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const saveMappingsMock = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  saveMappings: (...args: unknown[]) => saveMappingsMock(...args),
}))

import { GET, POST, PUT, DELETE } from '../route'

const emptyParams = { params: Promise.resolve({}) }

type StoredMapping = { source_name: string | null } | null

type ReadChain = {
  eq: (column: string, value: unknown) => ReadChain
  maybeSingle: () => Promise<{ data: StoredMapping; error: null }>
}

type UpsertCall = {
  table: string
  payload: Record<string, unknown>
  options: { onConflict?: string } | undefined
}

type BatchUpsertCall = {
  table: string
  rows: Record<string, unknown>[]
  options: { onConflict?: string } | undefined
}

/**
 * Supabase double for the POST path, which upserts an array of rows in
 * batches. Records every row verbatim so a test can assert which column each
 * value landed in.
 */
function createBatchRecordingSupabase() {
  const upserts: BatchUpsertCall[] = []

  const supabase = {
    from: (table: string) => ({
      upsert: async (rows: Record<string, unknown>[], options?: { onConflict?: string }) => {
        upserts.push({ table, rows, options })
        return { data: null, error: null }
      },
    }),
  }

  return { supabase, upserts }
}

/**
 * Supabase double that records the upsert payload and options verbatim.
 * `stored` is the mapping row the read-back finds (null = first save).
 */
function createRecordingSupabase(stored: StoredMapping) {
  const upserts: UpsertCall[] = []
  const readBackColumns: string[] = []

  const readChain: ReadChain = {
    eq: () => readChain,
    maybeSingle: async () => ({ data: stored, error: null }),
  }

  const supabase = {
    from: (table: string) => ({
      select: (columns: string) => {
        readBackColumns.push(columns)
        return readChain
      },
      upsert: (payload: Record<string, unknown>, options?: { onConflict?: string }) => {
        upserts.push({ table, payload, options })
        return {
          select: () => ({
            single: async () => ({ data: payload, error: null }),
          }),
        }
      },
    }),
  }

  return { supabase, upserts, readBackColumns }
}

describe('/api/import/sie/mappings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    saveMappingsMock.mockResolvedValue(undefined)
  })

  it('POST returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings: [] },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('POST returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings: [] },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('POST rejects a non-array mappings payload with 400', async () => {
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings: 'not-an-array' },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string; type: string }>(response)

    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(saveMappingsMock).not.toHaveBeenCalled()
  })

  it('POST rejects wrongly-typed mapping elements with 400 instead of a Postgres 500', async () => {
    // Element-level payloads used to be unvalidated: a numeric sourceAccount
    // or a string confidence sailed through to Postgres and surfaced as 500.
    const badElements = [
      [{ sourceAccount: 1920, targetAccount: '1930' }], // number, not string
      [{ sourceAccount: '1920', targetAccount: '1930', confidence: 'high' }],
      [{ sourceAccount: '1920', targetAccount: '1930', matchType: 'guess' }],
      [{ sourceAccount: '', targetAccount: '1930' }], // empty source key
      ['not-an-object'],
    ]
    for (const mappings of badElements) {
      const response = await POST(
        createMockRequest('/api/import/sie/mappings', { method: 'POST', body: { mappings } }),
        emptyParams,
      )
      expect(response.status, `payload ${JSON.stringify(mappings)} must be a 400`).toBe(400)
    }
    expect(saveMappingsMock).not.toHaveBeenCalled()
  })

  it('POST accepts unmapped elements (no targetAccount): saveMappings filters them', async () => {
    const mappings = [
      { sourceAccount: '1920', targetAccount: '1930' },
      { sourceAccount: '8888' }, // not yet mapped: valid on the wire
    ]
    const response = await POST(
      createMockRequest('/api/import/sie/mappings', { method: 'POST', body: { mappings } }),
      emptyParams,
    )
    expect(response.status).toBe(200)
    expect(saveMappingsMock).toHaveBeenCalledWith(supabase, 'company-1', mappings, 'user-1')
  })

  it('POST saves the mappings under the active company', async () => {
    const mappings = [{ sourceAccount: '1920', targetAccount: '1930' }]
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    // saveMappings(supabase, companyId, mappings): the second argument is the
    // tenant key and is written straight into sie_account_mappings.company_id.
    // The route used to pass user.id here; both are strings, so the compiler
    // could not tell them apart.
    expect(saveMappingsMock).toHaveBeenCalledWith(supabase, 'company-1', mappings, 'user-1')
    expect(saveMappingsMock.mock.calls[0][1]).not.toBe('user-1')
  })

  it('POST writes company_id, not the user id, into the mapping row', async () => {
    // One level deeper than the mocked-argument assertion above: run the real
    // saveMappings so the test sees which COLUMN the value lands in. company_id
    // is NOT NULL and FK-bound to companies, so a user UUID there can never
    // persist.
    const { saveMappings: realSaveMappings } =
      await vi.importActual<typeof import('@/lib/import/sie-import')>('@/lib/import/sie-import')
    const { supabase: recording, upserts } = createBatchRecordingSupabase()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: recording })
    saveMappingsMock.mockImplementation(realSaveMappings)

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: {
        mappings: [
          {
            sourceAccount: '1920',
            sourceName: 'Bank',
            targetAccount: '1930',
            confidence: 1.0,
            matchType: 'manual',
          },
        ],
      },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(200)

    expect(upserts).toHaveLength(1)
    expect(upserts[0].table).toBe('sie_account_mappings')
    expect(upserts[0].rows).toHaveLength(1)
    expect(upserts[0].rows[0]).toMatchObject({
      company_id: 'company-1',
      source_account: '1920',
      target_account: '1930',
    })
    expect(upserts[0].rows[0].company_id).not.toBe('user-1')
    expect(upserts[0].options?.onConflict).toBe('company_id,source_account')
  })

  it('POST ignores a company id smuggled into the body', async () => {
    // Tenancy comes from withRouteContext (membership-validated), never from
    // the caller. A body field naming another company must not redirect the
    // write.
    const mappings = [{ sourceAccount: '1920', targetAccount: '1930' }]
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings, companyId: 'company-2', company_id: 'company-2' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(200)

    expect(saveMappingsMock).toHaveBeenCalledWith(supabase, 'company-1', mappings, 'user-1')
    expect(saveMappingsMock.mock.calls[0][1]).not.toBe('company-2')
  })

  it('GET lists the saved mappings', async () => {
    enqueue({ data: [{ source_account: '1920', target_account: '1930' }] })

    const response = await GET(createMockRequest('/api/import/sie/mappings'), emptyParams)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('PUT rejects a body missing targetAccount with 400', async () => {
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1920' },
    })

    const response = await PUT(request, emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('PUT rejects wrongly-typed fields with 400 instead of a Postgres 500', async () => {
    const badBodies = [
      { sourceAccount: '1920', targetAccount: 1930 }, // number, not string
      { sourceAccount: 1920, targetAccount: '1930' },
      { sourceAccount: '1920', targetAccount: '1930', sourceName: 42 },
      { sourceAccount: '1920', targetAccount: '' }, // empty target
    ]
    for (const body of badBodies) {
      const response = await PUT(
        createMockRequest('/api/import/sie/mappings', { method: 'PUT', body }),
        emptyParams,
      )
      const { status, body: parsed } = await parseJsonResponse<{ type?: string }>(response)
      expect(status, `body ${JSON.stringify(body)} must be a 400`).toBe(400)
      expect(parsed.type).toBe('validation_error')
    }
  })

  it('PUT upserts a single mapping', async () => {
    enqueue({ data: null }) // read-back of the stored SIE label
    enqueue({ data: { source_account: '1920', target_account: '1930' } })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1920', targetAccount: '1930' },
    })

    const response = await PUT(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { target_account: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.target_account).toBe('1930')
  })

  it('PUT returns 500 when the stored-label read-back fails', async () => {
    enqueue({ error: { code: '42P01', message: 'relation does not exist' } })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1920', targetAccount: '1930' },
    })

    const response = await PUT(request, emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })

  it('PUT keeps the stored SIE label when the client does not resend it', async () => {
    // Re-save: the mapping row already carries the label from the SIE file's
    // #KONTO record. The client only sends the new target account.
    const { supabase: recording, upserts, readBackColumns } =
      createRecordingSupabase({ source_name: 'Kassa' })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: recording })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1910', targetAccount: '1930' },
    })

    const response = await PUT(request, emptyParams)
    expect(response.status).toBe(200)

    expect(readBackColumns).toEqual(['source_name'])
    expect(upserts).toHaveLength(1)
    // Full column set: every column the route is expected to write. id,
    // created_at and updated_at are deliberately absent (DB defaults/trigger).
    expect(upserts[0].payload).toEqual({
      user_id: 'user-1',
      company_id: 'company-1',
      source_account: '1910',
      source_name: 'Kassa',
      target_account: '1930',
      confidence: 1.0,
      match_type: 'manual',
    })
    // (user_id, source_account) was dropped by the multi-tenant refactor.
    expect(upserts[0].options?.onConflict).toBe('company_id,source_account')
  })

  it('PUT sets the SIE label on a first save when the client sends it', async () => {
    const { supabase: recording, upserts } = createRecordingSupabase(null)
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: recording })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1910', targetAccount: '1930', sourceName: 'Bankgiro' },
    })

    const response = await PUT(request, emptyParams)
    expect(response.status).toBe(200)

    expect(upserts[0].payload.source_name).toBe('Bankgiro')
  })

  it('PUT prefers the label the client sends over the stored one', async () => {
    const { supabase: recording, upserts } = createRecordingSupabase({ source_name: 'Kassa' })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: recording })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1910', targetAccount: '1930', sourceName: 'Kassa och bank' },
    })

    await PUT(request, emptyParams)

    expect(upserts[0].payload.source_name).toBe('Kassa och bank')
  })

  it('PUT leaves source_name null when no label is known anywhere', async () => {
    const { supabase: recording, upserts } = createRecordingSupabase(null)
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: recording })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1910', targetAccount: '1930', sourceName: '   ' },
    })

    await PUT(request, emptyParams)

    expect(upserts[0].payload.source_name).toBeNull()
  })

  it('DELETE returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/import/sie/mappings', { method: 'DELETE' })

    const response = await DELETE(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('DELETE removes a specific mapping', async () => {
    enqueue({ data: null })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'DELETE',
      searchParams: { sourceAccount: '1920' },
    })

    const response = await DELETE(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('DELETE of an unknown source account succeeds: the route has no 404 path', async () => {
    enqueue({ data: null })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'DELETE',
      searchParams: { sourceAccount: '9999' },
    })

    const response = await DELETE(request, emptyParams)
    const { status } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
  })
})
