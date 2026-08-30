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

const loadCounterLegTopologyMock = vi.fn()
vi.mock('@/lib/cash-accounts/service', () => ({
  loadCounterLegTopology: (...args: unknown[]) => loadCounterLegTopologyMock(...args),
}))

/** Topology stub mirroring lib/cash-accounts/service: orphan set + per-row context. */
function topology(
  orphaned: string[],
  contexts: Record<string, { settlementLedger: string | null; twins: string[] }> = {},
) {
  return {
    orphaned: new Set(orphaned),
    contextFor: (cashAccountId: string | null | undefined) => {
      const ctx = cashAccountId ? contexts[cashAccountId] : undefined
      return ctx
        ? { settlementLedger: ctx.settlementLedger, twins: new Set(ctx.twins) }
        : { settlementLedger: null, twins: new Set<string>() }
    },
  }
}

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
    loadCounterLegTopologyMock.mockResolvedValue(topology([]))
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
    loadCounterLegTopologyMock.mockResolvedValue(topology(['1931']))

    const response = await POST(request(), emptyParams)
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    const suggestions = body.template_suggestions[TX_ID] ?? []
    expect(suggestions.find((s) => s.template_id?.startsWith('cp:'))).toBeUndefined()
  })

  it('keeps a template whose stale BANK leg is a twin of the live row, shown on the settlement ledger (#1643 round 2)', async () => {
    // Transaction on the live 1940 row; the template was learned as 5010 /
    // 1931 before the reconnect moved the account. The commit guard rewrites
    // 1931 to 1940 and books it, so the suggestion must be offered the same way.
    enqueue({ data: [{ id: TX_ID, amount: -1200, currency: 'SEK', description: 'Hyra', cash_account_id: 'ca-live' }] })
    enqueue({ data: [] }) // mapping_rules
    enqueue({ data: [] }) // historical transactions
    enqueue({ data: { entity_type: 'aktiebolag' } }) // company_settings
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate({ debit_account: '5010', credit_account: '1931' }), confidence: 0.9 }]]),
    )
    loadCounterLegTopologyMock.mockResolvedValue(
      topology(['1931'], { 'ca-live': { settlementLedger: '1940', twins: ['1931'] } }),
    )

    const response = await POST(request(), emptyParams)
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    const suggestions = body.template_suggestions[TX_ID] ?? []
    expect(suggestions.some((s) => s.debit_account === '5010' && s.credit_account === '1940')).toBe(true)
    expect(suggestions.some((s) => s.credit_account === '1931')).toBe(false)
  })

  it('rewrites a both-active twin leg (two ledgers on one connection) to the settlement ledger (#1643 round 2)', async () => {
    // Nothing is orphaned: 1930 and 1931 are both enabled on the active
    // connection. The template learned on 1931 is still the same account.
    enqueue({ data: [{ id: TX_ID, amount: -1200, currency: 'SEK', description: 'Hyra', cash_account_id: 'ca-1930' }] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate({ debit_account: '5010', credit_account: '1931' }), confidence: 0.9 }]]),
    )
    loadCounterLegTopologyMock.mockResolvedValue(
      topology([], { 'ca-1930': { settlementLedger: '1930', twins: ['1931'] } }),
    )

    const response = await POST(request(), emptyParams)
    const { body } = await parseJsonResponse<Body>(response)
    const suggestions = body.template_suggestions[TX_ID] ?? []
    expect(suggestions.some((s) => s.debit_account === '5010' && s.credit_account === '1930')).toBe(true)
  })

  it('withholds a template whose twin leg sits in the COUNTER position (settlement against itself)', async () => {
    enqueue({ data: [{ id: TX_ID, amount: 217.04, currency: 'SEK', description: 'Ränta', cash_account_id: 'ca-live' }] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    findCounterpartyTemplatesBatchMock.mockResolvedValue(
      new Map([[TX_ID, { template: makeTemplate({ debit_account: '1940', credit_account: '1931' }), confidence: 0.9 }]]),
    )
    loadCounterLegTopologyMock.mockResolvedValue(
      topology([], { 'ca-live': { settlementLedger: '1940', twins: ['1931'] } }),
    )

    const response = await POST(request(), emptyParams)
    const { body } = await parseJsonResponse<Body>(response)
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
    loadCounterLegTopologyMock.mockResolvedValue(
      topology(['1931'], { 'ca-orphan': { settlementLedger: '1931', twins: ['1940'] } }),
    )

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
    loadCounterLegTopologyMock.mockResolvedValue(topology(['1931']))

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
    expect(loadCounterLegTopologyMock).not.toHaveBeenCalled()
  })
})
