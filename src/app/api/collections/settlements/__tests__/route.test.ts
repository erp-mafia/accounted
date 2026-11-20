/**
 * The settlements routes: GET /api/collections/settlements, GET
 * /api/collections/settlements/[id], POST .../[id]/book and POST
 * /api/collections/payments/[id]/book and .../rebook, through the real withRouteContext over
 * an in-memory database, with the booking services mocked: 401 without a
 * session, 400 on a bad request, 404 for a payout or payment the company does
 * not have, 403 for a viewer's writes, and the happy paths. The booking
 * services themselves are covered in lib/collections/__tests__.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemorySupabase, ADMIN_ID, COMPANY_ID, type MemorySupabase } from '@/lib/collections/__tests__/memory-supabase'

let db: MemorySupabase

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.client, createClient: async () => db.client }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const bookSettlementMock = vi.fn()
const resolveDuplicateMock = vi.fn()
vi.mock('@/lib/collections/settlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/settlements')>()),
  bookSettlement: (...args: unknown[]) => bookSettlementMock(...args),
  resolvePossibleDuplicate: (...args: unknown[]) => resolveDuplicateMock(...args),
}))
const rebookMock = vi.fn()
vi.mock('@/lib/collections/rebook', () => ({ rebookCollectedPayment: (...args: unknown[]) => rebookMock(...args) }))
const bookCollectedMock = vi.fn()
vi.mock('@/lib/collections/collected-payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/collected-payments')>()),
  bookCollectedPayment: (...args: unknown[]) => bookCollectedMock(...args),
}))

import { GET as LIST } from '../route'
import { GET as DETAIL } from '../[id]/route'
import { POST as BOOK } from '../[id]/book/route'
import { POST as DUPLICATE } from '../[id]/duplicate/route'
import { POST as BOOK_PAYMENT } from '../../payments/[id]/book/route'
import { POST as REBOOK_PAYMENT } from '../../payments/[id]/rebook/route'

const SETTLEMENT_ID = '33333333-3333-4333-8333-333333333333'
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_ID = '99999999-9999-4999-8999-999999999999'

type Handler = (request: Request, params: { params: Promise<{ id: string }> }) => Promise<Response>

function call(handler: Handler, method: 'GET' | 'POST', id: string, body?: unknown): Promise<Response> {
  return handler(
    new Request(`http://localhost/api/collections/settlements/${id}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

async function list(): Promise<Response> {
  return (LIST as unknown as (request: Request) => Promise<Response>)(new Request('http://localhost/api/collections/settlements'))
}

beforeEach(() => {
  vi.clearAllMocks()
  db = createMemorySupabase()
  db.seed('company_members', [{ company_id: COMPANY_ID, user_id: ADMIN_ID, role: 'owner' }])
  db.seed('collection_settlements', [
    {
      id: SETTLEMENT_ID,
      company_id: COMPANY_ID,
      connection_id: 'connection-1',
      provider_settlement_ref: '7731',
      payment_date: '2026-10-01',
      settlement_date: '2026-10-01',
      amount: 843.75,
      currency: 'SEK',
      provider_status_ok: true,
      bank_reference: 'PAYOUT 7731',
      status: 'needs_mapping',
      needs_mapping_reason: 'vat_unconfirmed',
      journal_entry_id: null,
      document_attachment_id: null,
      provider_acknowledged_at: null,
    },
  ])
  db.seed('collection_settlement_lines', [
    { id: 'line-0', company_id: COMPANY_ID, settlement_id: SETTLEMENT_ID, position: 0, kind: 'principal', in_payout: true, recipient: 'creditor', amount: 1000, tax_amount: 0, provider_type: 'p', original_invoice_ids: [], account_number: '1689', vat_account_number: null, account_chosen_by: null, booked: false },
    { id: 'line-1', company_id: COMPANY_ID, settlement_id: SETTLEMENT_ID, position: 1, kind: 'agency_fee_vat', in_payout: true, recipient: 'agency', amount: 31.25, tax_amount: 0, provider_type: 'p', original_invoice_ids: [], account_number: null, vat_account_number: null, account_chosen_by: null, booked: false },
  ])
  db.seed('collection_collected_payments', [
    { id: PAYMENT_ID, company_id: COMPANY_ID, case_id: 'case-1', invoice_id: 'invoice-1', provider_payment_ref: 'pay-1', paid_at: '2026-09-27', capital_paid: 1000, to_agency: 100, status: 'pending' },
  ])
  requireAuthMock.mockResolvedValue({
    user: { id: ADMIN_ID, email: 'ada@test.se', user_metadata: { full_name: 'Ada Admin' }, is_anonymous: false },
    supabase: db.client,
    error: null,
  })
  bookSettlementMock.mockResolvedValue({ ok: true, journalEntryId: 'je-d1', alreadyBooked: false, acknowledged: true })
  bookCollectedMock.mockResolvedValue({ ok: true, journalEntryId: 'je-c1', invoicePaymentId: 'ip-1', alreadyBooked: false })
  resolveDuplicateMock.mockResolvedValue({
    ok: true,
    resolution: 'not_duplicate',
    booking: { ok: true, journalEntryId: 'je-d1', alreadyBooked: false, acknowledged: true },
  })
  rebookMock.mockResolvedValue({
    ok: true,
    reversedEntryId: 'je-c1',
    stornoEntryId: 'je-storno',
    booking: { ok: true, journalEntryId: 'je-c2', invoicePaymentId: 'ip-2', alreadyBooked: false },
  })
})

describe('authentication and validation', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await list()).status).toBe(401)
    expect((await call(DETAIL, 'GET', SETTLEMENT_ID)).status).toBe(401)
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, {})).status).toBe(401)
    expect((await call(BOOK_PAYMENT, 'POST', PAYMENT_ID)).status).toBe(401)
    expect((await call(REBOOK_PAYMENT, 'POST', PAYMENT_ID)).status).toBe(401)
    expect((await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'not_duplicate' })).status).toBe(401)
    expect(resolveDuplicateMock).not.toHaveBeenCalled()
    expect(rebookMock).not.toHaveBeenCalled()
    expect(bookSettlementMock).not.toHaveBeenCalled()
    expect(bookCollectedMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a bad id or body', async () => {
    expect((await call(DETAIL, 'GET', 'nope')).status).toBe(400)
    expect((await call(BOOK, 'POST', 'nope', {})).status).toBe(400)
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: 1, account_number: '26410' }] })).status).toBe(400)
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: -1 }] })).status).toBe(400)
    expect((await call(BOOK_PAYMENT, 'POST', 'nope')).status).toBe(400)
    expect((await call(REBOOK_PAYMENT, 'POST', 'nope')).status).toBe(400)
    expect((await call(DUPLICATE, 'POST', 'nope', { resolution: 'not_duplicate' })).status).toBe(400)
    expect((await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'handled_elsewhere' })).status).toBe(400)
    expect((await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'handled_elsewhere', reason: '   ' })).status).toBe(400)
    expect((await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'maybe' })).status).toBe(400)
    expect(resolveDuplicateMock).not.toHaveBeenCalled()
    expect(rebookMock).not.toHaveBeenCalled()
    expect(bookSettlementMock).not.toHaveBeenCalled()
  })

  it('refuses a viewer the writes', async () => {
    db.rows('company_members')[0]!.role = 'viewer'
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, {})).status).toBe(403)
    expect((await call(BOOK_PAYMENT, 'POST', PAYMENT_ID)).status).toBe(403)
    expect((await call(REBOOK_PAYMENT, 'POST', PAYMENT_ID)).status).toBe(403)
    expect((await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'not_duplicate' })).status).toBe(403)
    expect(resolveDuplicateMock).not.toHaveBeenCalled()
    expect(rebookMock).not.toHaveBeenCalled()
    expect(bookSettlementMock).not.toHaveBeenCalled()
    expect(bookCollectedMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/collections/settlements', () => {
  it("answers the company's payouts and collected payments", async () => {
    const res = await list()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { settlements: { id: string; status: string }[]; collectedPayments: { id: string }[] } }
    expect(body.data.settlements).toEqual([expect.objectContaining({ id: SETTLEMENT_ID, status: 'needs_mapping', needsMappingReason: 'vat_unconfirmed', amount: 843.75 })])
    expect(body.data.collectedPayments).toEqual([expect.objectContaining({ id: PAYMENT_ID, status: 'pending', capitalPaid: 1000 })])
  })
})

describe('GET /api/collections/settlements/[id]', () => {
  it('answers the payout with its lines, and 404 for one the company does not have', async () => {
    const res = await call(DETAIL, 'GET', SETTLEMENT_ID)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { lines: { position: number; kind: string; accountNumber: string | null }[] } }
    expect(body.data.lines.map((l) => [l.position, l.kind, l.accountNumber])).toEqual([
      [0, 'principal', '1689'],
      [1, 'agency_fee_vat', null],
    ])
    expect((await call(DETAIL, 'GET', OTHER_ID)).status).toBe(404)
  })
})

describe('POST /api/collections/settlements/[id]/book', () => {
  it("records a person's VAT account and books the payout", async () => {
    const res = await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: 1, account_number: '6062' }] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { outcome: 'booked', journal_entry_id: 'je-d1', acknowledged: true } })
    expect(db.rows('collection_settlement_lines').find((l) => l.id === 'line-1')).toMatchObject({ account_number: '6062', account_chosen_by: ADMIN_ID })
    expect(bookSettlementMock).toHaveBeenCalledWith(expect.objectContaining({ db: db.client }), COMPANY_ID, SETTLEMENT_ID, { userId: ADMIN_ID })
  })

  it('refuses an account the VAT line cannot take, and a principal line, without booking', async () => {
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: 1, account_number: '1930' }] })).status).toBe(400)
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: 0, account_number: '1930' }] })).status).toBe(400)
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: 7, account_number: '6062' }] })).status).toBe(400)
    expect(bookSettlementMock).not.toHaveBeenCalled()
  })

  it('answers needs_mapping with the reason when a person is still needed', async () => {
    bookSettlementMock.mockResolvedValue({ ok: false, outcome: 'needs_mapping', reason: 'unbalanced', issues: [{ reason: 'unbalanced', position: null }] })
    const res = await call(BOOK, 'POST', SETTLEMENT_ID, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { outcome: 'needs_mapping', reason: 'unbalanced' } })
  })

  it('answers 404, 409 for the refusals', async () => {
    expect((await call(BOOK, 'POST', OTHER_ID, { lines: [{ position: 1, account_number: '6062' }] })).status).toBe(404)
    bookSettlementMock.mockResolvedValue({ ok: false, outcome: 'not_found' })
    expect((await call(BOOK, 'POST', OTHER_ID, {})).status).toBe(404)
    bookSettlementMock.mockResolvedValue({ ok: false, outcome: 'busy' })
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, {})).status).toBe(409)
    bookSettlementMock.mockResolvedValue({ ok: false, outcome: 'document_unavailable' })
    const pending = await call(BOOK, 'POST', SETTLEMENT_ID, {})
    expect(pending.status).toBe(409)
    expect(await pending.json()).toMatchObject({ error: { code: 'COLLECTION_SETTLEMENT_DOCUMENT_PENDING' } })
    db.rows('collection_settlements')[0]!.status = 'booked'
    expect((await call(BOOK, 'POST', SETTLEMENT_ID, { lines: [{ position: 1, account_number: '6062' }] })).status).toBe(409)
  })
})

describe('POST /api/collections/payments/[id]/book', () => {
  it('books the collected payment as the person who clicked', async () => {
    const res = await call(BOOK_PAYMENT, 'POST', PAYMENT_ID)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { outcome: 'booked', journal_entry_id: 'je-c1', invoice_payment_id: 'ip-1' } })
    expect(bookCollectedMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), PAYMENT_ID, { userId: ADMIN_ID })
  })

  it('answers needs_review with the reason, 404 and 409 for the refusals', async () => {
    bookCollectedMock.mockResolvedValue({ ok: false, outcome: 'needs_review', reason: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(await (await call(BOOK_PAYMENT, 'POST', PAYMENT_ID)).json()).toMatchObject({
      data: { outcome: 'needs_review', reason: 'MATCH_AMOUNT_EXCEEDS_REMAINING' },
    })
    bookCollectedMock.mockResolvedValue({ ok: false, outcome: 'not_found' })
    expect((await call(BOOK_PAYMENT, 'POST', OTHER_ID)).status).toBe(404)
    bookCollectedMock.mockResolvedValue({ ok: false, outcome: 'busy' })
    expect((await call(BOOK_PAYMENT, 'POST', PAYMENT_ID)).status).toBe(409)
    bookCollectedMock.mockResolvedValue({ ok: false, outcome: 'ignored' })
    expect((await call(BOOK_PAYMENT, 'POST', PAYMENT_ID)).status).toBe(409)
  })
})

describe('POST /api/collections/payments/[id]/rebook', () => {
  it('stornos and books the collected payment again as the person who clicked', async () => {
    const res = await call(REBOOK_PAYMENT, 'POST', PAYMENT_ID)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { reversed_entry_id: 'je-c1', storno_entry_id: 'je-storno', outcome: 'booked', journal_entry_id: 'je-c2', invoice_payment_id: 'ip-2' },
    })
    expect(rebookMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), PAYMENT_ID, { userId: ADMIN_ID })
  })

  it('answers needs_review when the new booking is refused, and 404 and 409 for the refusals', async () => {
    rebookMock.mockResolvedValue({
      ok: true,
      reversedEntryId: 'je-c1',
      stornoEntryId: 'je-storno',
      booking: { ok: false, outcome: 'needs_review', reason: 'INVOICE_PAID_NO_FISCAL_PERIOD' },
    })
    expect(await (await call(REBOOK_PAYMENT, 'POST', PAYMENT_ID)).json()).toMatchObject({
      data: { reversed_entry_id: 'je-c1', outcome: 'needs_review', reason: 'INVOICE_PAID_NO_FISCAL_PERIOD' },
    })
    rebookMock.mockResolvedValue({ ok: false, outcome: 'not_found' })
    expect((await call(REBOOK_PAYMENT, 'POST', OTHER_ID)).status).toBe(404)
    for (const [outcome, code] of [
      ['not_booked', 'COLLECTED_PAYMENT_NOT_BOOKED'],
      ['settled', 'COLLECTED_PAYMENT_SETTLED'],
      ['busy', 'COLLECTED_PAYMENT_BUSY'],
      ['voucher_not_posted', 'COLLECTED_PAYMENT_VOUCHER_NOT_POSTED'],
    ] as const) {
      rebookMock.mockResolvedValue({ ok: false, outcome })
      const res = await call(REBOOK_PAYMENT, 'POST', PAYMENT_ID)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { code } })
    }
  })
})

describe('POST /api/collections/settlements/[id]/duplicate', () => {
  it('books a payout the person confirms is not a duplicate', async () => {
    const res = await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'not_duplicate' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { outcome: 'booked', journal_entry_id: 'je-d1', settlement: { id: SETTLEMENT_ID } } })
    expect(resolveDuplicateMock).toHaveBeenCalledWith(expect.objectContaining({ db: db.client }), COMPANY_ID, SETTLEMENT_ID, { userId: ADMIN_ID }, {
      resolution: 'not_duplicate',
    })
  })

  it('marks a payout handled elsewhere with the trimmed reason', async () => {
    resolveDuplicateMock.mockResolvedValue({ ok: true, resolution: 'handled_elsewhere' })
    const res = await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'handled_elsewhere', reason: ' Bokförd för hand ' })
    expect(await res.json()).toMatchObject({ data: { outcome: 'ignored' } })
    expect(resolveDuplicateMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, SETTLEMENT_ID, { userId: ADMIN_ID }, {
      resolution: 'handled_elsewhere',
      reason: 'Bokförd för hand',
    })
  })

  it('answers needs_mapping when the booking still needs a person, 404 and 409 for the refusals', async () => {
    resolveDuplicateMock.mockResolvedValue({
      ok: true,
      resolution: 'not_duplicate',
      booking: { ok: false, outcome: 'needs_mapping', reason: 'vat_unconfirmed', issues: [] },
    })
    expect(await (await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'not_duplicate' })).json()).toMatchObject({
      data: { outcome: 'needs_mapping', reason: 'vat_unconfirmed' },
    })
    resolveDuplicateMock.mockResolvedValue({ ok: false, outcome: 'not_found' })
    expect((await call(DUPLICATE, 'POST', OTHER_ID, { resolution: 'not_duplicate' })).status).toBe(404)
    resolveDuplicateMock.mockResolvedValue({ ok: false, outcome: 'not_possible_duplicate' })
    const res = await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'not_duplicate' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'COLLECTION_SETTLEMENT_NOT_POSSIBLE_DUPLICATE' } })
    resolveDuplicateMock.mockResolvedValue({ ok: false, outcome: 'busy' })
    expect((await call(DUPLICATE, 'POST', SETTLEMENT_ID, { resolution: 'not_duplicate' })).status).toBe(409)
  })
})
