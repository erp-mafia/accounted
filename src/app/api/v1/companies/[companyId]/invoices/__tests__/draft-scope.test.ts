/**
 * invoices:draft over the wire (crm#1548): a key that may only create and
 * edit drafts. Every door that moves an invoice out of draft answers 403
 * INSUFFICIENT_SCOPE before anything is read; the draft doors open; a PATCH
 * never takes an invoice out of draft; a self-billed sale (booked at once)
 * is refused on the create door.
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

vi.mock('@/lib/invoices/self-billed-sale', () => ({
  resolveSelfBilledSaleDraft: vi.fn(),
  createSelfBilledSaleInvoice: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createSelfBilledSaleInvoice } from '@/lib/invoices/self-billed-sale'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST as createInvoice } from '../route'
import { POST as bulkCreate } from '../bulk-create/route'
import { POST as bulkBook } from '../bulk-book/route'
import { PATCH as updateInvoice, DELETE as deleteInvoice } from '../[id]/route'
import { POST as sendInvoice } from '../[id]/send/route'
import { POST as sendPeppol } from '../[id]/send-peppol/route'
import { POST as creditInvoice } from '../[id]/credit/route'
import { POST as markPaid } from '../[id]/mark-paid/route'
import { POST as markSent } from '../[id]/mark-sent/route'
import { POST as bookInvoice } from '../[id]/book/route'
import { POST as cancelInvoice } from '../[id]/cancel/route'
import { POST as quoteStatus } from '../[id]/quote-status/route'
import { POST as openCollection } from '../[id]/collection/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockSelfBilled = createSelfBilledSaleInvoice as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'
const BASE = `http://localhost/api/v1/companies/${COMPANY_ID}/invoices`

const DRAFT_KEY = ['invoices:read', 'invoices:draft']

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
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const invoiceParams = () => ({ params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID }) })

const DRAFT_ROW = {
  id: INVOICE_ID,
  company_id: COMPANY_ID,
  customer_id: CUSTOMER_ID,
  invoice_number: null,
  status: 'draft',
  document_type: 'invoice',
  quote_status: null,
  journal_entry_id: null,
  is_self_billed: false,
  credited_invoice_id: null,
  currency: 'SEK',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  notes: null,
  total: 1250,
}

function withTables(tables: Record<string, unknown>) {
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { user_id: USER_ID, company_id: COMPANY_ID, role: 'owner' }, error: null },
      ...tables,
    } as never).supabase,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  keyWith(DRAFT_KEY)
  withTables({ invoices: { data: DRAFT_ROW, error: null } })
})

describe('a draft-only key on the doors out of draft', () => {
  const exits: Array<[string, () => Promise<Response>]> = [
    ['send', () => sendInvoice(req('POST', `${BASE}/${INVOICE_ID}/send`), invoiceParams())],
    ['send-peppol', () => sendPeppol(req('POST', `${BASE}/${INVOICE_ID}/send-peppol`), invoiceParams())],
    ['credit', () => creditInvoice(req('POST', `${BASE}/${INVOICE_ID}/credit`), invoiceParams())],
    ['mark-paid', () => markPaid(req('POST', `${BASE}/${INVOICE_ID}/mark-paid`), invoiceParams())],
    ['mark-sent', () => markSent(req('POST', `${BASE}/${INVOICE_ID}/mark-sent`), invoiceParams())],
    ['book', () => bookInvoice(req('POST', `${BASE}/${INVOICE_ID}/book`), invoiceParams())],
    ['cancel', () => cancelInvoice(req('POST', `${BASE}/${INVOICE_ID}/cancel`), invoiceParams())],
    ['quote-status', () => quoteStatus(req('POST', `${BASE}/${INVOICE_ID}/quote-status`, { status: 'accepted' }), invoiceParams())],
    ['collection', () => openCollection(req('POST', `${BASE}/${INVOICE_ID}/collection`), invoiceParams())],
    ['delete', () => deleteInvoice(req('DELETE', `${BASE}/${INVOICE_ID}`), invoiceParams())],
    ['bulk-book', () => bulkBook(req('POST', `${BASE}/bulk-book`, { invoice_ids: [INVOICE_ID] }), companyParams)],
  ]

  it.each(exits)('%s answers 403 INSUFFICIENT_SCOPE naming invoices:write', async (_door, call) => {
    const res = await call()
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(json.error.details.required_scope).toBe('invoices:write')
    // Refused at the scope gate: no company, invoice or customer was read.
    expect(mockServiceClient).not.toHaveBeenCalled()
  })
})

describe('a draft-only key on the draft doors', () => {
  it('401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(401)
  })

  it('PATCH edits a draft (dry run)', async () => {
    const res = await updateInvoice(
      req('PATCH', `${BASE}/${INVOICE_ID}?dry_run=true`, { notes: 'Granskas av en människa' }),
      invoiceParams(),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.preview).toMatchObject({ status: 'draft', notes: 'Granskas av en människa' })
  })

  it('PATCH cannot take an invoice out of draft: status is not a field of the update', async () => {
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}`, { status: 'sent' }), invoiceParams())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('PATCH carrying status beside a field keeps the draft a draft (status ignored, dry run)', async () => {
    const res = await updateInvoice(
      req('PATCH', `${BASE}/${INVOICE_ID}?dry_run=true`, { status: 'sent', notes: 'x' }),
      invoiceParams(),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview.status).toBe('draft')
  })

  it('PATCH on a sent invoice answers 409 INVOICE_UPDATE_NOT_DRAFT', async () => {
    withTables({ invoices: { data: { ...DRAFT_ROW, status: 'sent', invoice_number: 'F-1' }, error: null } })
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('PATCH on an unknown invoice answers 404', async () => {
    withTables({ invoices: { data: null, error: null } })
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(404)
  })

  it('POST create passes the scope gate (400 on a body without items)', async () => {
    const res = await createInvoice(req('POST', BASE, { customer_id: CUSTOMER_ID }), companyParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('POST create answers 404 for an unknown customer, past the scope gate', async () => {
    withTables({ customers: { data: null, error: null } })
    const res = await createInvoice(
      req('POST', BASE, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
      }),
      companyParams,
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('POST create refuses a self-billed sale, booked at once, with 403 and books nothing', async () => {
    const res = await createInvoice(
      req('POST', BASE, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-10',
        received_date: '2026-05-11',
        due_date: '2026-06-09',
        currency: 'SEK',
        is_self_billed: true,
        external_invoice_number: 'K-1',
        items: [{ description: 'Leverans', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 }],
      }),
      companyParams,
    )
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(json.error.details.required_scope).toBe('invoices:write')
    expect(mockSelfBilled).not.toHaveBeenCalled()
  })

  it('bulk-create passes the scope gate (400 on an empty batch)', async () => {
    const res = await bulkCreate(req('POST', `${BASE}/bulk-create`, { invoices: [] }), companyParams)
    expect(res.status).toBe(400)
  })
})

describe('an invoices:write key keeps the draft doors', () => {
  it('PATCH edits a draft (dry run)', async () => {
    keyWith(['invoices:read', 'invoices:write'])
    const res = await updateInvoice(req('PATCH', `${BASE}/${INVOICE_ID}?dry_run=true`, { notes: 'x' }), invoiceParams())
    expect(res.status).toBe(200)
  })

  it('a key with neither draft nor write is refused on create', async () => {
    keyWith(['invoices:read'])
    const res = await createInvoice(req('POST', BASE, { customer_id: CUSTOMER_ID }), companyParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.details.required_scope).toBe('invoices:draft')
  })
})
