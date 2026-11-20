/**
 * POST /api/parties/[id]/setoffs through the real withRouteContext: 401
 * without a session, 400 on a bad body, 404 for an unknown or unparsable
 * party, 503 while COUNTERPARTY_SETOFF_ENABLED is off, the dry run answered as
 * the preview, the booking answered 201, and a refusal answered with its
 * registered code. The service itself is tested in
 * lib/invoices/counterparty-setoff/__tests__.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PARTY_ID = '11111111-1111-4111-8111-111111111111'
const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const SUPPLIER_INVOICE_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '33333333-3333-4333-8333-333333333333'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  isCompanyAdmin: vi.fn().mockResolvedValue(true),
  companyAdminRequiredResponse: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}), createServiceClient: () => ({}) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const book = vi.fn()
const canonical = vi.fn()
vi.mock('@/lib/invoices/counterparty-setoff/book', () => ({ bookCounterpartySetoff: (...a: unknown[]) => book(...a) }))
vi.mock('@/lib/invoices/counterparty-setoff/state', () => ({ resolveCanonicalParties: (...a: unknown[]) => canonical(...a) }))

import { POST } from '../route'

function call(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/parties/${id}/setoffs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

const BODY = { invoice_id: INVOICE_ID, supplier_invoice_id: SUPPLIER_INVOICE_ID }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('COUNTERPARTY_SETOFF_ENABLED', '1')
  requireAuthMock.mockResolvedValue({ user: { id: USER_ID, email: 'a@test.se', is_anonymous: false }, supabase: {}, error: null })
  canonical.mockResolvedValue(new Map([[PARTY_ID, PARTY_ID]]))
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/parties/[id]/setoffs', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call(PARTY_ID, BODY)).status).toBe(401)
    expect(book).not.toHaveBeenCalled()
  })

  it('answers 503 while the switch is off', async () => {
    vi.stubEnv('COUNTERPARTY_SETOFF_ENABLED', '')
    const res = await call(PARTY_ID, BODY)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SETOFF_DISABLED')
    expect(book).not.toHaveBeenCalled()
  })

  it('answers 400 on a bad body', async () => {
    expect((await call(PARTY_ID, { invoice_id: INVOICE_ID })).status).toBe(400)
    expect((await call(PARTY_ID, { ...BODY, amount: -5 })).status).toBe(400)
    expect((await call(PARTY_ID, { ...BODY, setoff_date: '30/9/2026' })).status).toBe(400)
    expect(book).not.toHaveBeenCalled()
  })

  it('answers 404 for a party id it cannot parse or find', async () => {
    expect((await call('not-a-uuid', BODY)).status).toBe(404)
    canonical.mockResolvedValue(new Map())
    const res = await call(PARTY_ID, BODY)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SETOFF_PARTY_NOT_FOUND')
    expect(book).not.toHaveBeenCalled()
  })

  it('answers the preview on a dry run, pinned to the canonical party', async () => {
    canonical.mockResolvedValue(new Map([[PARTY_ID, 'canonical-party']]))
    book.mockResolvedValue({ ok: true, dryRun: true, preview: { amount: 1388 } })
    const res = await call(PARTY_ID, { ...BODY, dry_run: true, amount: 1388, setoff_date: '2026-09-30', note: ' Avtal ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { amount: 1388 } })
    expect(book).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: USER_ID }),
      {
        invoiceId: INVOICE_ID,
        supplierInvoiceId: SUPPLIER_INVOICE_ID,
        amount: 1388,
        setoffDate: '2026-09-30',
        note: 'Avtal',
        expectedPartyId: 'canonical-party',
      },
      { dryRun: true },
    )
  })

  it('books the set-off and answers 201 with any warning', async () => {
    book.mockResolvedValue({
      ok: true,
      data: { setoff_id: 's-1', journal_entry_id: 'je-1' },
      warnings: [{ code: 'SETOFF_UNDERLAG_NOT_ARCHIVED', message_sv: 'x', message_en: 'y' }],
    })
    const res = await call(PARTY_ID, BODY)
    expect(res.status).toBe(201)
    const json = (await res.json()) as { data: { setoff_id: string }; warnings: Array<{ code: string }> }
    expect(json.data.setoff_id).toBe('s-1')
    expect(json.warnings[0]?.code).toBe('SETOFF_UNDERLAG_NOT_ARCHIVED')
    expect(book.mock.calls[0]![2]).toEqual({ dryRun: false })
  })

  it('answers a refusal with its registered code and status', async () => {
    book.mockResolvedValue({ ok: false, code: 'SETOFF_PARTY_MISMATCH' })
    const res = await call(PARTY_ID, BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SETOFF_PARTY_MISMATCH')

    book.mockResolvedValue({ ok: false, code: 'SETOFF_INVOICE_NOT_FOUND' })
    expect((await call(PARTY_ID, BODY)).status).toBe(404)
  })
})
