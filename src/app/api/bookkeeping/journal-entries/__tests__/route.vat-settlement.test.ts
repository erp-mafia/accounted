/**
 * The Moms page books its reviewed momsredovisning through this route
 * (source_type 'vat_settlement' plus the period it settles). The route gives
 * it the gates the v1 and MCP booking have (accounted#58): a period already
 * settled refuses before anything is written, and the verifikat carries the
 * period's source_id, so a booking that loses the race on
 * journal_entries_vat_settlement_live_unique is answered 409 naming the winner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createTableMockSupabase, makeJournalEntry } from '@/tests/helpers'
import type { VatSettlementProposal } from '@/lib/reports/vat-settlement'

const { supabase: mockSupabase, setTable, reset } = createTableMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: (): unknown => logger }
  return { createLogger: () => logger }
})

const mockCreateJournalEntry = vi.fn()
const mockCreateDraftEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
}))

const mockBuildProposal = vi.fn()
vi.mock('@/lib/reports/vat-settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/vat-settlement')>()),
  buildVatSettlementProposal: (...args: unknown[]) => mockBuildProposal(...args),
}))

import { POST } from '../route'
import { vatSettlementSourceId } from '@/lib/reports/vat-settlement-booking'

const emptyParams = { params: Promise.resolve({}) }
const FISCAL_PERIOD = '11111111-1111-4111-8111-111111111111'
const PERIOD = { start: '2026-07-01', end: '2026-09-30' }

/** The reviewed proposal's lines as the dialog sends them, period attached. */
const REVIEWED = {
  fiscal_period_id: FISCAL_PERIOD,
  entry_date: '2026-09-30',
  description: 'Momsredovisning Kvartal 3 2026',
  source_type: 'vat_settlement',
  lines: [
    { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
    { account_number: '2650', debit_amount: 0, credit_amount: 2500 },
  ],
  vat_settlement_period: { period_type: 'quarterly', year: 2026, period: 3 },
}

function proposal(overrides: Partial<VatSettlementProposal> = {}): VatSettlementProposal {
  return {
    period: { type: 'quarterly', year: 2026, period: 3, ...PERIOD },
    period_label: 'Kvartal 3 2026',
    entry_date: '2026-09-30',
    entry_date_reason: null,
    description: 'Momsredovisning Kvartal 3 2026',
    lines: [
      { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 2500 },
    ],
    filed_net: 2500,
    rounding_amount: 0,
    is_empty: false,
    existing_entries: [],
    ...overrides,
  }
}

const post = (body: unknown, query = '') =>
  POST(createMockRequest(`/api/bookkeeping/journal-entries${query}`, { method: 'POST', body }), emptyParams)

describe('POST /api/bookkeeping/journal-entries: a reviewed VAT settlement (accounted#58)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    mockBuildProposal.mockResolvedValue(proposal())
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post(REVIEWED))
    expect(status).toBe(401)
    expect(mockBuildProposal).not.toHaveBeenCalled()
  })

  it('400 for a period that does not exist (quarter 5), before anything is read', async () => {
    const { status } = await parseJsonResponse(
      await post({ ...REVIEWED, vat_settlement_period: { period_type: 'quarterly', year: 2026, period: 5 } }),
    )
    expect(status).toBe(400)
    expect(mockBuildProposal).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('books the reviewed lines keyed on the period, and the engine never sees the period field', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))

    const { status } = await parseJsonResponse(await post(REVIEWED))

    expect(status).toBe(200)
    expect(mockBuildProposal).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'quarterly', 2026, 3, { fiscalPeriodId: undefined },
    )
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateJournalEntry.mock.calls[0][3] as Record<string, unknown>
    expect(input).toMatchObject({
      source_type: 'vat_settlement',
      source_id: vatSettlementSourceId('company-1', PERIOD),
      lines: REVIEWED.lines,
    })
    expect(input).not.toHaveProperty('vat_settlement_period')
  })

  it('409 VAT_SETTLEMENT_ALREADY_BOOKED naming the posted settlement, writing nothing', async () => {
    mockBuildProposal.mockResolvedValue(
      proposal({
        existing_entries: [
          { id: 'je-old', voucher_series: 'I', voucher_number: 4, entry_date: '2026-09-30', status: 'posted', source_type: 'vat_settlement' },
        ],
      }),
    )

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await post(REVIEWED),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('VAT_SETTLEMENT_ALREADY_BOOKED')
    expect(body.error.details).toMatchObject({ journal_entry_id: 'je-old', voucher_series: 'I', voucher_number: 4 })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a draft of an already settled period too', async () => {
    mockBuildProposal.mockResolvedValue(
      proposal({
        existing_entries: [
          { id: 'je-old', voucher_series: 'I', voucher_number: 4, entry_date: '2026-09-30', status: 'posted', source_type: 'vat_settlement' },
        ],
      }),
    )

    const { status } = await parseJsonResponse(await post(REVIEWED, '?as_draft=true'))

    expect(status).toBe(409)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('409 naming the winner when a concurrent booking of the period took the key first', async () => {
    mockCreateJournalEntry.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "journal_entries_vat_settlement_live_unique"'),
    )
    // alreadyBookedByKey reads the winner by the period's source_id.
    const key = vatSettlementSourceId('company-1', PERIOD)
    setTable('journal_entries', (chain) =>
      chain.some((c) => c.method === 'eq' && c.args[0] === 'source_id' && c.args[1] === key)
        ? { data: { id: 'je-winner', voucher_series: 'I', voucher_number: 7, entry_date: '2026-09-30' } }
        : { data: null },
    )

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await post(REVIEWED),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('VAT_SETTLEMENT_ALREADY_BOOKED')
    expect(body.error.details).toMatchObject({ journal_entry_id: 'je-winner', voucher_number: 7 })
  })

  it('passes a helårsmoms period\'s räkenskapsår to the proposal', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))
    // loadReportPeriod checks the fiscal period is the company's.
    setTable('fiscal_periods', { data: { id: FISCAL_PERIOD, period_start: '2025-07-01', period_end: '2026-06-30' } })
    mockBuildProposal.mockResolvedValue(
      proposal({ period: { type: 'yearly', year: 2026, period: 1, start: '2025-07-01', end: '2026-06-30' } }),
    )

    const { status } = await parseJsonResponse(
      await post({
        ...REVIEWED,
        vat_settlement_period: { period_type: 'yearly', year: 2026, period: 1, fiscal_period_id: FISCAL_PERIOD },
      }),
    )

    expect(status).toBe(200)
    expect(mockBuildProposal).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: FISCAL_PERIOD },
    )
    expect(mockCreateJournalEntry.mock.calls[0][3]).toMatchObject({
      source_id: vatSettlementSourceId('company-1', { start: '2025-07-01', end: '2026-06-30' }),
    })
  })

  it('404 FISCAL_PERIOD_NOT_FOUND for a räkenskapsår that is not the company\'s, writing nothing', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({
        ...REVIEWED,
        vat_settlement_period: { period_type: 'yearly', year: 2026, period: 1, fiscal_period_id: FISCAL_PERIOD },
      }),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(mockBuildProposal).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('a VAT template in the plain form (no period) books as before, unkeyed', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))
    const { vat_settlement_period: _omit, ...templateBody } = REVIEWED

    const { status } = await parseJsonResponse(await post(templateBody))

    expect(status).toBe(200)
    expect(mockBuildProposal).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry.mock.calls[0][3]).not.toHaveProperty('source_id')
  })

  it('ignores a period sent with a manual voucher', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))

    const { status } = await parseJsonResponse(await post({ ...REVIEWED, source_type: 'manual' }))

    expect(status).toBe(200)
    expect(mockBuildProposal).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry.mock.calls[0][3]).not.toHaveProperty('source_id')
  })
})
