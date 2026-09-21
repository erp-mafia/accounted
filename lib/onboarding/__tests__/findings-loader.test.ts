import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadBooksFindings } from '../findings'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/onboarding/ai-clients.server', () => ({ loadConnectedAiClients: vi.fn().mockResolvedValue([]) }))
const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const PERIOD = { id: 'period-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }
const EMPTY_SUMMARY = { period_name: null, revenue: null, result: null, vat_balance: 0, ledger_1630: 0 }

/** The eleven reads in call order; `summary` and `underlag` are the two RPCs. */
function enqueueReads(overrides: {
  entries?: number
  skv?: { status: string }[]
  summary?: unknown
  underlag?: unknown
} = {}) {
  enqueue({ data: null, count: overrides.entries ?? 1 })
  enqueue({ data: [PERIOD] })
  enqueue({ count: 0 }); enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ count: 0 })
  enqueue({ data: overrides.skv ?? [] }); enqueue({ data: [] }); enqueue({ data: [{ entry_date: '2026-06-30' }] })
  enqueue({ data: 'summary' in overrides ? overrides.summary : EMPTY_SUMMARY })
  enqueue({ data: 'underlag' in overrides ? overrides.underlag : { ok: true, total_count: 0 } })
}

describe('findings read integrity', () => {
  beforeEach(() => { vi.clearAllMocks(); reset() })

  it.each(Array.from({ length: 11 }, (_, index) => index))('does not report an empty company when query %s fails', async (failedIndex) => {
    for (let index = 0; index < 11; index++) enqueue({ data: [], count: 0, error: index === failedIndex ? { code: '57014', message: 'timeout' } : null })
    await expect(loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')).rejects.toMatchObject({ code: '57014' })
  })

  it('fails instead of showing zero balances when the summary has no payload', async () => {
    enqueueReads({ summary: null })
    await expect(loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')).rejects.toThrow(/get_onboarding_books_summary/)
  })

  it('fails instead of showing zero missing underlag when the count is refused', async () => {
    enqueueReads({ underlag: { ok: false, code: 'VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN' } })
    await expect(loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')).rejects.toThrow(/FORBIDDEN/)
  })
})

describe('findings figures', () => {
  beforeEach(() => { vi.clearAllMocks(); reset() })

  it('reads the ledger through the company-scoped RPCs, never through journal lines', async () => {
    enqueueReads()
    await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(supabase.rpc).toHaveBeenCalledWith('get_onboarding_books_summary', { p_company_id: 'company-1' })
    expect(supabase.rpc).toHaveBeenCalledWith('verifikat_without_documents', { p_company_id: 'company-1', p_limit: 1, p_offset: 0 })
    expect(supabase.from).not.toHaveBeenCalledWith('journal_entry_lines')
  })

  it('rounds the exact sums to öre and keeps the signs', async () => {
    enqueueReads({
      summary: { period_name: '2026', revenue: '1000.006', result: -250.4, vat_balance: '2500.00', ledger_1630: -120 },
      underlag: { ok: true, total_count: 7 },
    })
    const findings = await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(findings.books).toMatchObject({
      revenue: 1000.01, result: -250.4, periodName: '2026', vatBalance: 2500, missingUnderlag: 7, lastEntryDate: '2026-06-30',
    })
    expect(findings.skv.ledger1630).toBe(-120)
  })

  it('shows zero balances, not null, for books with nothing on 26xx or 1630', async () => {
    enqueueReads({ summary: { period_name: '2026', revenue: 0, result: 0, vat_balance: 0, ledger_1630: 0 } })
    const findings = await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(findings.books.revenue).toBe(0)
    expect(findings.books.vatBalance).toBe(0)
    expect(findings.skv.ledger1630).toBe(0)
  })

  it('leaves period figures null when only empty or future periods exist', async () => {
    enqueueReads({ summary: { ...EMPTY_SUMMARY, vat_balance: 40 } })
    const findings = await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(findings.books).toMatchObject({ revenue: null, result: null, periodName: null, vatBalance: 40 })
  })

  it('shows no figures at all for a company without books', async () => {
    enqueueReads({ entries: 0 })
    const findings = await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(findings.books).toMatchObject({ entries: 0, revenue: null, result: null, periodName: null, vatBalance: null, missingUnderlag: 0 })
    expect(findings.skv.ledger1630).toBeNull()
    expect(findings.books.periods).toEqual([{ name: '2026', start: '2026-01-01', end: '2026-12-31', isClosed: false, continuityVerified: null }])
  })

  it('excludes inactive tax connections', async () => {
    enqueueReads({ skv: [{ status: 'needs_reconsent' }] })
    const findings = await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(findings.skv.connected).toBe(false)
  })
})
