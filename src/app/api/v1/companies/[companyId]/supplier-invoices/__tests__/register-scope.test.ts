/**
 * suppliers:register over the wire (crm#1548): a key that registers and
 * edits supplier invoices that post nothing. The create door hands the
 * service registerOnly (which refuses a registration that would post a
 * verifikat); the PATCH refuses an invoice with a verifikat, an approval, a
 * bank entry or a självfaktura; approve, book, credit and mark-paid answer
 * 403 before anything is read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn() }
})

vi.mock('@/lib/supplier-invoices/create', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supplier-invoices/create')>('@/lib/supplier-invoices/create')
  return { ...actual, createSupplierInvoice: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST as registerInvoice } from '../route'
import { PATCH as updateInvoice } from '../[id]/route'
import { POST as approveInvoice } from '../[id]/approve/route'
import { POST as bookInvoice } from '../[id]/book/route'
import { POST as creditInvoice } from '../[id]/credit/route'
import { POST as markPaid } from '../[id]/mark-paid/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreate = createSupplierInvoice as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUPPLIER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'
const BASE = `http://localhost/api/v1/companies/${COMPANY_ID}/supplier-invoices`

const REGISTER_KEY = ['suppliers:read', 'suppliers:register']

function keyWith(scopes: string[]) {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Integration key',
    scopes,
    mode: 'live',
  })
}

function req(method: string, url: string, body: unknown = {}): Request {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': `idem-${method}-${url}`,
    },
    body: JSON.stringify(body),
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const invoiceParams = () => ({ params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID }) })

const REGISTERED_ROW = {
  id: INVOICE_ID,
  company_id: COMPANY_ID,
  supplier_id: SUPPLIER_ID,
  status: 'registered',
  supplier_invoice_number: 'LF-1',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  registration_journal_entry_id: null,
  approved_at: null,
  bank_entered_at: null,
  is_self_billed: false,
  notes: null,
}

function withInvoice(row: Record<string, unknown> | null) {
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { user_id: USER_ID, company_id: COMPANY_ID, role: 'owner' }, error: null },
      supplier_invoices: { data: row, error: null },
    } as never).supabase,
  )
}

const BODY = {
  supplier_id: SUPPLIER_ID,
  supplier_invoice_number: 'LF-1',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  items: [{ description: 'Material', amount: 1000, account_number: '4010', vat_rate: 0.25 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  keyWith(REGISTER_KEY)
  withInvoice(REGISTERED_ROW)
  mockCreate.mockResolvedValue({ ok: true, dryRun: true, preview: { would_create_registration_journal_entry: false } })
})

describe('POST /supplier-invoices with a register-only key', () => {
  it('401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await registerInvoice(req('POST', BASE, BODY), companyParams)
    expect(res.status).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('400 on an invalid body, past the scope gate', async () => {
    const res = await registerInvoice(req('POST', BASE, { supplier_id: SUPPLIER_ID }), companyParams)
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('hands the service registerOnly, and answers its refusal as 403', async () => {
    mockCreate.mockResolvedValue({
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      details: { required_scope: 'suppliers:write', reason: 'posts_verifikat' },
    })
    const res = await registerInvoice(req('POST', BASE, BODY), companyParams)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate.mock.calls[0][2]).toEqual({ dryRun: false, registerOnly: true })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(json.error.details).toMatchObject({ required_scope: 'suppliers:write', reason: 'posts_verifikat' })
  })

  it('registers what posts nothing (dry run passes through)', async () => {
    const res = await registerInvoice(req('POST', `${BASE}?dry_run=true`, BODY), companyParams)
    expect(res.status).toBe(200)
    expect(mockCreate.mock.calls[0][2]).toEqual({ dryRun: true, registerOnly: true })
  })

  it('a suppliers:write key registers as before, without registerOnly', async () => {
    keyWith(['suppliers:read', 'suppliers:write'])
    await registerInvoice(req('POST', `${BASE}?dry_run=true`, BODY), companyParams)
    expect(mockCreate.mock.calls[0][2]).toEqual({ dryRun: true, registerOnly: false })
  })
})

describe('PATCH /supplier-invoices/:id with a register-only key', () => {
  it('edits a registered invoice that posted nothing (dry run)', async () => {
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}?dry_run=true`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(200)
  })

  it.each([
    ['a registration verifikat', { registration_journal_entry_id: 'je-1' }],
    ['an approval', { approved_at: '2026-05-13T08:00:00Z' }],
    ['a bank entry', { bank_entered_at: '2026-05-13T08:00:00Z' }],
    ['a självfaktura', { is_self_billed: true }],
  ])('403 on an invoice with %s', async (_what, extra) => {
    withInvoice({ ...REGISTERED_ROW, ...extra })
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(json.error.details.required_scope).toBe('suppliers:write')
  })

  it('404 on an unknown invoice', async () => {
    withInvoice(null)
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(404)
  })

  it('a suppliers:write key still edits an invoice with a verifikat (dry run)', async () => {
    keyWith(['suppliers:read', 'suppliers:write'])
    withInvoice({ ...REGISTERED_ROW, registration_journal_entry_id: 'je-1' })
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}?dry_run=true`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(200)
  })
})

describe('a register-only key on approve, book, credit and pay', () => {
  it.each([
    ['approve', () => approveInvoice(req('POST', `${BASE}/${INVOICE_ID}/approve`), invoiceParams())],
    ['book', () => bookInvoice(req('POST', `${BASE}/${INVOICE_ID}/book`), invoiceParams())],
    ['credit', () => creditInvoice(req('POST', `${BASE}/${INVOICE_ID}/credit`), invoiceParams())],
    ['mark-paid', () => markPaid(req('POST', `${BASE}/${INVOICE_ID}/mark-paid`), invoiceParams())],
  ] as Array<[string, () => Promise<Response>]>)('%s answers 403 INSUFFICIENT_SCOPE', async (_door, call) => {
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
    expect(mockServiceClient).not.toHaveBeenCalled()
  })
})
