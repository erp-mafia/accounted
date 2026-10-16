/**
 * POST /api/v1/companies/:companyId/invoices/:id/cancel (operation
 * invoices.cancel, accounted#20): makulera a quote or proforma through the
 * service the dashboard route uses.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`cancel route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`)
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

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events'
import { POST as cancelDocument } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'
import { toHandle } from '@/lib/handles'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(opts: { auth?: boolean; idempotencyKey?: boolean; dryRun?: boolean; id?: string } = {}): Request {
  const headers: Record<string, string> = {}
  if (opts.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (opts.idempotencyKey !== false) headers['Idempotency-Key'] = 'idem1234-7777-4abc-8def-1234567890ab'
  const id = opts.id ?? QUOTE_ID
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${id}/cancel${opts.dryRun ? '?dry_run=true' : ''}`
  return new Request(url, { method: 'POST', headers })
}

const params = (id = QUOTE_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

const QUOTE = {
  id: QUOTE_ID,
  company_id: COMPANY_ID,
  invoice_number: 'OF-007',
  document_type: 'quote',
  status: 'sent',
  quote_status: 'open',
  invoice_date: '2026-10-01',
  total: 12500,
  currency: 'SEK',
}

function client(invoices: unknown) {
  const db = createTableMockSupabase({ company_members: MEMBER, invoices: invoices as never })
  mockServiceClient.mockReturnValue(db.supabase)
  return db
}

const cancelled = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  eventBus.on('invoice.cancelled', cancelled)
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/cancel', () => {
  it('returns 401 without a bearer token', async () => {
    client({ data: QUOTE })

    const res = await cancelDocument(makeRequest({ auth: false }), params())

    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('returns 403 for a key without invoices:write', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'Read key',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    const db = client({ data: QUOTE })

    const res = await cancelDocument(makeRequest(), params())

    expect(res.status).toBe(403)
    expect(db.findCall('invoices', 'update')).toBeUndefined()
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID id, before any read', async () => {
    const db = client({ data: QUOTE })

    const res = await cancelDocument(makeRequest({ id: 'not-a-uuid' }), params('not-a-uuid'))

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(db.findCall('invoices', 'select')).toBeUndefined()
  })

  it('returns 404 INVOICE_NOT_FOUND for a document outside the company', async () => {
    const db = client({ data: null })

    const res = await cancelDocument(makeRequest(), params())

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_NOT_FOUND')
    expect(db.findCalls('invoices', 'eq')).toContainEqual(['company_id', COMPANY_ID])
  })

  it('returns 400 INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA for a sales invoice and writes nothing', async () => {
    const db = client({ data: { ...QUOTE, document_type: 'invoice', status: 'draft', quote_status: null } })

    const res = await cancelDocument(makeRequest(), params())

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA')
    expect(body.error.details.documentType).toBe('invoice')
    expect(db.findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('returns 409 INVOICE_CANCEL_RACE when the status changed between the read and the write', async () => {
    client([{ data: QUOTE }, { data: null }])

    const res = await cancelDocument(makeRequest(), params())

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INVOICE_CANCEL_RACE')
    expect(cancelled).not.toHaveBeenCalled()
  })

  it.each(['quote', 'proforma'])('cancels a %s, records who did it and answers the cancelled document', async (documentType) => {
    const row = { ...QUOTE, document_type: documentType, quote_status: documentType === 'quote' ? 'open' : null }
    const db = client([{ data: row }, { data: { ...row, status: 'cancelled' } }])

    const res = await cancelDocument(makeRequest(), params())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      id: QUOTE_ID,
      handle: toHandle('invoice', QUOTE_ID),
      invoice_number: 'OF-007',
      document_type: documentType,
      status: 'cancelled',
      quote_status: row.quote_status,
      already_cancelled: false,
    })
    expect(db.findCall('invoices', 'update')?.[0]).toMatchObject({ status: 'cancelled' })
    // Compare-and-set on the status that was read.
    expect(db.findCalls('invoices', 'eq')).toContainEqual(['status', 'sent'])
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(cancelled.mock.calls[0][0]).toMatchObject({ userId: USER_ID, companyId: COMPANY_ID })
  })

  it('answers an already cancelled document unchanged, with no write and no second event', async () => {
    const db = client({ data: { ...QUOTE, status: 'cancelled' } })

    const res = await cancelDocument(makeRequest(), params())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ status: 'cancelled', already_cancelled: true })
    expect(db.findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('previews on ?dry_run=true without writing or emitting', async () => {
    const db = client({ data: QUOTE })

    const res = await cancelDocument(makeRequest({ dryRun: true }), params())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(JSON.stringify(body)).toContain('"current_status":"sent"')
    expect(db.findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('requires an Idempotency-Key', async () => {
    const db = client({ data: QUOTE })

    const res = await cancelDocument(makeRequest({ idempotencyKey: false }), params())

    expect(res.status).toBe(400)
    expect(db.findCall('invoices', 'update')).toBeUndefined()
  })
})
