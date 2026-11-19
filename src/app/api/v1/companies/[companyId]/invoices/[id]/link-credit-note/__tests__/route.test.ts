/**
 * POST /api/v1/companies/:companyId/invoices/:id/link-credit-note (operation
 * invoices.link-credit-note, crm#1852): the door only. The rule is pinned in
 * lib/invoices/__tests__/link-credit-note.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`link-credit-note route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`)
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

vi.mock('@/lib/invoices/link-credit-note', () => ({ linkCreditNoteToInvoice: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { linkCreditNoteToInvoice } from '@/lib/invoices/link-credit-note'
import { POST as linkCreditNote } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'
import { toHandle } from '@/lib/handles'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockLink = linkCreditNoteToInvoice as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CREDIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(opts: { auth?: boolean; dryRun?: boolean; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'idem1234-7777-4abc-8def-1234567890ab',
  }
  if (opts.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/link-credit-note${opts.dryRun ? '?dry_run=true' : ''}`
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(opts.body ?? { credit_note_id: CREDIT_ID }) })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID }) }

const PAIR = {
  creditNote: { id: CREDIT_ID, invoice_number: '1043', status: 'sent', credited_invoice_id: INVOICE_ID },
  original: { id: INVOICE_ID, invoice_number: '1042', status: 'credited' },
  creditAmount: 12500,
  openAmount: 12500,
  currency: 'SEK',
}

function key(scopes: string[]) {
  return { userId: USER_ID, companyId: COMPANY_ID, apiKeyId: 'ak_1', apiKeyName: 'CI key', scopes, mode: 'live' }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue(key(['invoices:write']))
  const db = createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } })
  mockServiceClient.mockReturnValue(db.supabase)
  mockLink.mockResolvedValue({ ok: true, dryRun: false, ...PAIR })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/link-credit-note', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await linkCreditNote(makeRequest({ auth: false }), params)

    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 403 for a key without invoices:write', async () => {
    mockValidate.mockResolvedValue(key(['invoices:read']))

    const res = await linkCreditNote(makeRequest(), params)

    expect(res.status).toBe(403)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR without a credit note id, before the service runs', async () => {
    const res = await linkCreditNote(makeRequest({ body: { credit_note_id: 'not-a-uuid' } }), params)

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 404 INVOICE_NOT_FOUND and says which document is missing', async () => {
    mockLink.mockResolvedValue({ ok: false, code: 'INVOICE_NOT_FOUND', details: { missing: 'credit_note' } })

    const res = await linkCreditNote(makeRequest(), params)

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
    expect(body.error.details.missing).toBe('credit_note')
  })

  it('links the pair of the path and the body for the key\'s user, and answers both documents', async () => {
    const res = await linkCreditNote(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(mockLink.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY_ID,
      userId: USER_ID,
      invoiceId: INVOICE_ID,
      creditNoteId: CREDIT_ID,
      dryRun: false,
    })
    expect((await res.json()).data).toEqual({
      invoice: { id: INVOICE_ID, handle: toHandle('invoice', INVOICE_ID), invoice_number: '1042', status: 'credited' },
      credit_note: { id: CREDIT_ID, invoice_number: '1043', status: 'sent', credited_invoice_id: INVOICE_ID },
      credited_amount: 12500,
      currency: 'SEK',
      journal_entry_id: null,
    })
  })

  it('previews on ?dry_run=true through the service\'s own dry run', async () => {
    mockLink.mockResolvedValue({
      ok: true,
      dryRun: true,
      ...PAIR,
      creditNote: { ...PAIR.creditNote, status: 'credited', credited_invoice_id: null },
      original: { ...PAIR.original, status: 'overdue' },
    })

    const res = await linkCreditNote(makeRequest({ dryRun: true }), params)

    expect(res.status).toBe(200)
    expect(mockLink.mock.calls[0][0]).toMatchObject({ dryRun: true })
    const text = JSON.stringify(await res.json())
    expect(text).toContain('"invoice_current_status":"overdue"')
    expect(text).toContain('"journal_entry":null')
  })

  it.each([
    ['INVOICE_CREDIT_LINK_BOOKING_REQUIRED', 409, { reason: 'accrual_method' }],
    ['INVOICE_CREDIT_LINK_AMOUNT_MISMATCH', 400, { reason: 'partial_credit', credit_amount: 5000, open_amount: 12500 }],
    ['INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH', 400, undefined],
    ['INVOICE_CREDIT_LINK_CURRENCY_MISMATCH', 400, { reason: 'currency' }],
    ['INVOICE_CREDIT_LINK_ALREADY_LINKED', 409, { credited_invoice_id: INVOICE_ID, same_invoice: true }],
    ['INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', 409, { reason: 'status', status: 'credited' }],
    ['INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE', 400, { reason: 'not_negative' }],
    ['INVOICE_CREDIT_LINK_RACE', 409, undefined],
  ])('answers the refusal %s as %i with its reason', async (code, status, details) => {
    mockLink.mockResolvedValue({ ok: false, code, ...(details ? { details } : {}) })

    const res = await linkCreditNote(makeRequest(), params)

    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body.error.code).toBe(code)
    expect(body.error.message).toBeTruthy()
    if (details) expect(body.error.details).toMatchObject(details)
  })

  it('answers a database failure as 500 without leaking it', async () => {
    mockLink.mockResolvedValue({ ok: false, code: 'DB_ERROR', cause: { message: 'relation "secret" does not exist' } })

    const res = await linkCreditNote(makeRequest(), params)

    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })
})
