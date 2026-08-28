/**
 * POST /api/transactions/suggest-categories: counterparty suggestions whose
 * learned accounts reference an ORPHANED cash-account ledger are withheld
 * (issue #1643 problem 4). A learned template carries the ledger it was
 * learned on; replaying it after a broken reconnect would pre-fill a junk
 * balance-sheet account as the booking dialog's counter-account.
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

const findCounterpartyTemplatesBatchMock = vi.fn()
// Spread the real module: category-suggestions also imports pure helpers from
// here (normalizeCounterpartyName), and only the DB-backed batch lookup is stubbed.
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: (...args: unknown[]) => findCounterpartyTemplatesBatchMock(...args),
}))

const getOrphanedCounterLedgersMock = vi.fn()
vi.mock('@/lib/cash-accounts/service', () => ({
  getOrphanedCounterLedgers: (...args: unknown[]) => getOrphanedCounterLedgersMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const TX_ID = '22222222-2222-4222-8222-222222222222'

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cpt-1',
    user_id: null,
    company_id: 'company-1',
    counterparty_name: 'SEB',
    counterparty_aliases: [],
    debit_account: '1940',
    credit_account: '1931',
    vat_treatment: null,
    vat_account: null,
    category: null,
    line_pattern: null,
    occurrence_count: 3,
    confidence: 0.9,
    last_seen_date: '2026-07-01',
    source: 'auto_learned',
    is_active: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

/** Queue the four queries the route always runs, in order. */
function enqueueBaseQueries() {
  enqueue({ data: [{ id: TX_ID, amount: 217.04, currency: 'SEK', description: 'Ränta' }] }) // transactions
  enqueue({ data: [] }) // mapping_rules
  enqueue({ data: [] }) // historical transactions
  enqueue({ data: { entity_type: 'aktiebolag' } }) // company_settings
}

function request() {
  return createMockRequest('/api/transactions/suggest-categories', {
    method: 'POST',
    body: { transaction_ids: [TX_ID] },
  })
}

type Body = {
  template_suggestions: Record<string, Array<{ template_id: string; debit_account: string; credit_account: string }>>
}

describe('POST /api/transactions/suggest-categories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getOrphanedCounterLedgersMock.mockResolvedValue(new Set())
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(request(), emptyParams)
    expect(response.status).toBe(401)
  })

  it('withholds a counterparty suggestion whose learned accounts hit an orphaned ledger', async () => {
    enqueueBaseQueries()
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate(), confidence: 0.9 }]]),
    )
    getOrphanedCounterLedgersMock.mockResolvedValue(new Set(['1931']))

    const response = await POST(request(), emptyParams)
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    const suggestions = body.template_suggestions[TX_ID] ?? []
    expect(suggestions.find((s) => s.template_id?.startsWith('cp:'))).toBeUndefined()
  })

  it('keeps a learned suggestion whose only 19xx leg is the transaction\'s OWN (orphaned) settlement ledger', async () => {
    // A transaction still stranded on the orphaned 1931 row: the template
    // learned as 5010 / 1931 is valid for it, the 1931 leg is its bank side.
    enqueue({ data: [{ id: TX_ID, amount: -1200, currency: 'SEK', description: 'Hyra', cash_account_id: 'ca-orphan' }] })
    enqueue({ data: [] }) // mapping_rules
    enqueue({ data: [] }) // historical transactions
    enqueue({ data: { entity_type: 'aktiebolag' } }) // company_settings
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate({ debit_account: '5010', credit_account: '1931' }), confidence: 0.9 }]]),
    )
    getOrphanedCounterLedgersMock.mockResolvedValue(new Set(['1931']))
    enqueue({ data: [{ id: 'ca-orphan', ledger_account: '1931' }] }) // cash_accounts id -> ledger

    const response = await POST(request(), emptyParams)
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    const suggestions = body.template_suggestions[TX_ID] ?? []
    expect(suggestions.some((s) => s.debit_account === '5010' && s.credit_account === '1931')).toBe(true)
  })

  it('keeps a counterparty suggestion whose accounts are clean', async () => {
    enqueueBaseQueries()
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate({ debit_account: '1930', credit_account: '8311' }), confidence: 0.9 }]]),
    )
    getOrphanedCounterLedgersMock.mockResolvedValue(new Set(['1931']))

    const response = await POST(request(), emptyParams)
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    const suggestions = body.template_suggestions[TX_ID] ?? []
    expect(suggestions.some((s) => s.debit_account === '1930' && s.credit_account === '8311')).toBe(true)
  })

  it('does not query the orphan set when no counterparty template references a 19xx account', async () => {
    enqueueBaseQueries()
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate({ debit_account: '6570', credit_account: '2440' }), confidence: 0.9 }]]),
    )

    const response = await POST(request(), emptyParams)
    expect(response.status).toBe(200)
    expect(getOrphanedCounterLedgersMock).not.toHaveBeenCalled()
  })
})
