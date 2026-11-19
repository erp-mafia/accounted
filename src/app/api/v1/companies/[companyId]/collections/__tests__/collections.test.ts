/**
 * Collections through the v1 doors of the operation registry
 * (src/lib/operations/collections.ts and collections-booking.ts):
 *   GET  /api/v1/companies/:companyId/collections/candidates                        (collections.candidates.list)
 *   GET  /api/v1/companies/:companyId/invoices/:id/collection                       (collections.cases.get)
 *   POST /api/v1/companies/:companyId/invoices/:id/collection                       (collections.cases.open)
 *   POST /api/v1/companies/:companyId/invoices/:id/collection/actions               (collections.cases.action)
 *   GET  /api/v1/companies/:companyId/collections/settlements                       (collections.settlements.list)
 *   POST /api/v1/companies/:companyId/collections/payments/:paymentId/book          (collections.payments.book)
 *   POST /api/v1/companies/:companyId/collections/settlements/:settlementId/book    (collections.settlements.book)
 *
 * The operations' rules have their own tests (lib/operations/__tests__);
 * here each run() is a spy, so these pin the door: scopes, the path ids in
 * the input, validation, the dry run, the staging, and that a handover or an
 * escalation is never committed from a key (STAGE_REQUIRED).
 */
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

// An in-memory idempotency_keys table, as in lib/operations/__tests__/v1-stage.test.ts.
const idempotency = vi.hoisted(() => ({ store: new Map<string, { hash: string; status: string; body: unknown }>() }))
vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>('@/lib/api/idempotency')
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(async () => null),
    storeIdempotencyResponse: vi.fn(async () => {}),
    claimIdempotencyKey: vi.fn(async (_s: unknown, target: { key: string; requestHash: string }) => {
      const hit = idempotency.store.get(target.key)
      if (hit) return { replay: { status: hit.status, body: hit.body } }
      return {
        claim: {
          complete: async (status: string, body: unknown) => {
            idempotency.store.set(target.key, { hash: target.requestHash, status, body })
          },
          release: async () => {},
        },
      }
    }),
  }
})

// Each operation keeps its contract (schemas, scope, http binding, staging); only run() is a spy.
const runs = vi.hoisted(() => ({
  candidates: vi.fn(),
  caseGet: vi.fn(),
  caseOpen: vi.fn(),
  caseAction: vi.fn(),
  settlementsList: vi.fn(),
  paymentBook: vi.fn(),
  settlementBook: vi.fn(),
}))
vi.mock('@/lib/operations/collections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operations/collections')>('@/lib/operations/collections')
  return {
    ...actual,
    collectionsCandidatesList: { ...actual.collectionsCandidatesList, run: runs.candidates },
    collectionsCasesGet: { ...actual.collectionsCasesGet, run: runs.caseGet },
    collectionsCasesOpen: { ...actual.collectionsCasesOpen, run: runs.caseOpen },
    collectionsCasesAction: { ...actual.collectionsCasesAction, run: runs.caseAction },
  }
})
vi.mock('@/lib/operations/collections-booking', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operations/collections-booking')>('@/lib/operations/collections-booking')
  return {
    ...actual,
    collectionsSettlementsList: { ...actual.collectionsSettlementsList, run: runs.settlementsList },
    collectionsPaymentsBook: { ...actual.collectionsPaymentsBook, run: runs.paymentBook },
    collectionsSettlementsBook: { ...actual.collectionsSettlementsBook, run: runs.settlementBook },
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { GET as candidatesRoute } from '../candidates/route'
import { GET as settlementsRoute } from '../settlements/route'
import { POST as settlementBookRoute } from '../settlements/[settlementId]/book/route'
import { POST as paymentBookRoute } from '../payments/[paymentId]/book/route'
import { GET as caseGetRoute, POST as caseOpenRoute } from '../../invoices/[id]/collection/route'
import { POST as caseActionRoute } from '../../invoices/[id]/collection/actions/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PAYMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SETTLEMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const STAGED_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

function client() {
  const insertEcho: TableMockResolver = (calls) => {
    const insert = calls.find((c) => c.method === 'insert')
    if (!insert) return { data: null }
    return {
      data: {
        id: STAGED_ID,
        status: 'pending',
        batch_id: null,
        result_data: null,
        rejection_category: null,
        rejection_reason: null,
        created_at: '2026-10-22T10:00:00.000Z',
        resolved_at: null,
        ...(insert.args[0] as Record<string, unknown>),
      },
    }
  }
  const mock = createTableMockSupabase({ company_members: OWNER, pending_operations: insertEcho })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

function get(path: string): Request {
  return new Request(`${BASE}/${path}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } })
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const invoiceParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID }) }

function auth(scopes: string[]) {
  return { userId: 'user-1', companyId: COMPANY_ID, apiKeyId: 'ak_1', apiKeyName: 'Inkassoflöde', scopes, mode: 'live' }
}

const CASE = { case_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', stage: 'registered' }

/** A write spy: its dry run previews, its commit answers `data`. */
function writeRun(data: Record<string, unknown>, preview: Record<string, unknown> = {}) {
  return async (_ctx: unknown, input: Record<string, unknown>, options: { dryRun: boolean }) =>
    options.dryRun ? { ok: true, dryRun: true, preview: { ...input, ...preview } } : { ok: true, data }
}

beforeEach(() => {
  vi.clearAllMocks()
  idempotency.store.clear()
  mockValidate.mockResolvedValue(auth(['invoices:read', 'invoices:write', 'bookkeeping:write']))
  runs.candidates.mockResolvedValue({ ok: true, data: { candidates: [] } })
  runs.caseGet.mockResolvedValue({ ok: true, data: { case: null, withdraw_fee: null } })
  runs.settlementsList.mockResolvedValue({ ok: true, data: { provider: null, settlements: [], collected_payments: [], settlement: null } })
  runs.caseOpen.mockImplementation(writeRun({ case: CASE, registered: true }))
  runs.caseAction.mockImplementation(writeRun({ case: CASE }))
  runs.paymentBook.mockImplementation(writeRun({ outcome: 'booked', journal_entry_id: 'je-1' }, { paid_at: '2026-10-20' }))
  runs.settlementBook.mockImplementation(
    writeRun({ outcome: 'booked', journal_entry_id: 'je-2' }, { payment_date: '2026-10-21', amount: 843.75, lines: [], voucher_lines: [] }),
  )
})

describe('GET /collections/candidates', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    client()
    expect((await candidatesRoute(get('collections/candidates'), companyParams)).status).toBe(401)
    expect(runs.candidates).not.toHaveBeenCalled()
  })

  it('403 without invoices:read', async () => {
    mockValidate.mockResolvedValue(auth(['bookkeeping:write']))
    client()
    expect((await candidatesRoute(get('collections/candidates'), companyParams)).status).toBe(403)
    expect(runs.candidates).not.toHaveBeenCalled()
  })

  it('lists the candidates, passing the query through', async () => {
    client()
    const res = await candidatesRoute(get('collections/candidates?include_ineligible=true'), companyParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ candidates: [] })
    // A query string carries the flag as the string 'true' (MCP sends a boolean); the run reads both.
    expect(runs.candidates.mock.calls[0][1]).toEqual({ include_ineligible: 'true' })
  })
})

describe('GET /invoices/:id/collection', () => {
  it('reads the invoice\'s case with the path id as invoice_id', async () => {
    client()
    const res = await caseGetRoute(get(`invoices/${INVOICE_ID}/collection`), invoiceParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ case: null, withdraw_fee: null })
    expect(runs.caseGet.mock.calls[0][1]).toEqual({ invoice_id: INVOICE_ID })
  })

  it('400 VALIDATION_ERROR for an invoice id that is not a uuid', async () => {
    client()
    const res = await caseGetRoute(get('invoices/F-1042/collection'), { params: Promise.resolve({ companyId: COMPANY_ID, id: 'F-1042' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(runs.caseGet).not.toHaveBeenCalled()
  })
})

describe('POST /invoices/:id/collection (the handover)', () => {
  it('400 STAGE_REQUIRED for a direct call: nothing is handed over', async () => {
    const mock = client()
    const res = await caseOpenRoute(post(`invoices/${INVOICE_ID}/collection`, { expected_remaining: 12500 }), invoiceParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('STAGE_REQUIRED')
    expect(runs.caseOpen).not.toHaveBeenCalled()
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('?dry_run=true previews the handover and writes nothing', async () => {
    client()
    const res = await caseOpenRoute(post(`invoices/${INVOICE_ID}/collection?dry_run=true`, { expected_remaining: 12500 }), invoiceParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ dry_run: true })
    expect(runs.caseOpen.mock.calls[0][1]).toMatchObject({ invoice_id: INVOICE_ID, expected_remaining: 12500 })
    expect(runs.caseOpen.mock.calls[0][2]).toEqual({ dryRun: true })
  })

  it('?stage=true stages it for a person to approve in Accounted and answers 202', async () => {
    const mock = client()
    const res = await caseOpenRoute(post(`invoices/${INVOICE_ID}/collection?stage=true`, { expected_remaining: 12500 }), invoiceParams)
    expect(res.status).toBe(202)
    expect((await res.json()).data).toMatchObject({
      pending_operation_id: STAGED_ID,
      operation_type: 'open_collection_case',
      status: 'pending',
      risk_level: 'high',
    })
    const inserts = mock.payloads('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ operation_type: 'open_collection_case', actor_type: 'api_key', actor_id: 'ak_1' })
    expect(runs.caseOpen.mock.calls.every((call) => (call[2] as { dryRun: boolean }).dryRun)).toBe(true)
  })

  it('400 VALIDATION_ERROR without expected_remaining', async () => {
    client()
    const res = await caseOpenRoute(post(`invoices/${INVOICE_ID}/collection?stage=true`, {}), invoiceParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(runs.caseOpen).not.toHaveBeenCalled()
  })

  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue(auth(['invoices:read']))
    client()
    const res = await caseOpenRoute(post(`invoices/${INVOICE_ID}/collection?stage=true`, { expected_remaining: 12500 }), invoiceParams)
    expect(res.status).toBe(403)
  })
})

describe('POST /invoices/:id/collection/actions', () => {
  it('commits an agent-approvable action (pause) directly', async () => {
    client()
    const res = await caseActionRoute(post(`invoices/${INVOICE_ID}/collection/actions`, { action: 'pause', until: '2026-11-01' }), invoiceParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ case: CASE })
    expect(runs.caseAction.mock.calls[0][1]).toMatchObject({ invoice_id: INVOICE_ID, action: 'pause', until: '2026-11-01' })
    expect(runs.caseAction.mock.calls[0][2]).toEqual({ dryRun: false })
  })

  it('400 STAGE_REQUIRED for an escalation (approve_step), which ?stage=true stages', async () => {
    client()
    const direct = await caseActionRoute(post(`invoices/${INVOICE_ID}/collection/actions`, { action: 'approve_step' }), invoiceParams)
    expect(direct.status).toBe(400)
    expect((await direct.json()).error.code).toBe('STAGE_REQUIRED')
    expect(runs.caseAction).not.toHaveBeenCalled()

    const mock = client()
    const staged = await caseActionRoute(post(`invoices/${INVOICE_ID}/collection/actions?stage=true`, { action: 'approve_step' }), invoiceParams)
    expect(staged.status).toBe(202)
    expect((await staged.json()).data).toMatchObject({ operation_type: 'collection_case_action', title: 'Inkassoärende: godkänn nästa steg' })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(1)
  })

  it('400 VALIDATION_ERROR for an action the contract does not know', async () => {
    client()
    const res = await caseActionRoute(post(`invoices/${INVOICE_ID}/collection/actions`, { action: 'shred' }), invoiceParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })
})

describe('GET /collections/settlements', () => {
  it('lists payouts and collected payments', async () => {
    client()
    const res = await settlementsRoute(get('collections/settlements'), companyParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ settlements: [], collected_payments: [] })
  })

  it('reads one payout\'s lines with settlement_id, refusing an id that is not a uuid', async () => {
    client()
    await settlementsRoute(get(`collections/settlements?settlement_id=${SETTLEMENT_ID}`), companyParams)
    expect(runs.settlementsList.mock.calls[0][1]).toEqual({ settlement_id: SETTLEMENT_ID })

    client()
    const res = await settlementsRoute(get('collections/settlements?settlement_id=1000000216'), companyParams)
    expect(res.status).toBe(400)
  })
})

describe('POST /collections/payments/:paymentId/book', () => {
  const params = { params: Promise.resolve({ companyId: COMPANY_ID, paymentId: PAYMENT_ID }) }

  it('books directly, with the path id as collected_payment_id', async () => {
    client()
    const res = await paymentBookRoute(post(`collections/payments/${PAYMENT_ID}/book`, {}), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ outcome: 'booked', journal_entry_id: 'je-1' })
    expect(runs.paymentBook.mock.calls[0][1]).toEqual({ collected_payment_id: PAYMENT_ID })
    expect(runs.paymentBook.mock.calls[0][2]).toEqual({ dryRun: false })
  })

  it('?stage=true stages the booking with the payment day pinned', async () => {
    const mock = client()
    const res = await paymentBookRoute(post(`collections/payments/${PAYMENT_ID}/book?stage=true`, {}), params)
    expect(res.status).toBe(202)
    expect(mock.payloads('pending_operations', 'insert')[0]).toMatchObject({
      operation_type: 'book_collected_payment',
      params: { collected_payment_id: PAYMENT_ID, payment_date: '2026-10-20' },
    })
  })

  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue(auth(['invoices:read', 'bookkeeping:write']))
    client()
    expect((await paymentBookRoute(post(`collections/payments/${PAYMENT_ID}/book`, {}), params)).status).toBe(403)
  })
})

describe('POST /collections/settlements/:settlementId/book', () => {
  const params = { params: Promise.resolve({ companyId: COMPANY_ID, settlementId: SETTLEMENT_ID }) }

  it('books directly with the account choices, the path id as settlement_id', async () => {
    client()
    const res = await settlementBookRoute(
      post(`collections/settlements/${SETTLEMENT_ID}/book`, { lines: [{ position: 1, account_number: '2641' }] }),
      params,
    )
    expect(res.status).toBe(200)
    expect(runs.settlementBook.mock.calls[0][1]).toEqual({ settlement_id: SETTLEMENT_ID, lines: [{ position: 1, account_number: '2641' }] })
  })

  it('?dry_run=true previews the voucher', async () => {
    client()
    const res = await settlementBookRoute(post(`collections/settlements/${SETTLEMENT_ID}/book?dry_run=true`, {}), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ dry_run: true })
    expect(runs.settlementBook.mock.calls[0][2]).toEqual({ dryRun: true })
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue(auth(['invoices:read', 'invoices:write']))
    client()
    expect((await settlementBookRoute(post(`collections/settlements/${SETTLEMENT_ID}/book`, {}), params)).status).toBe(403)
  })
})
