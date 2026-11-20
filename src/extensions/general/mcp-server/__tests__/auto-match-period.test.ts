/**
 * Unit tests for gnubok_auto_match_period.
 *
 * Verifies registration, dry-run preview shape, confidence threshold filtering,
 * and the no-match counters. Per-item staging fault isolation is covered by
 * the existing stagePendingOperation tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

vi.mock('@/lib/invoices/invoice-matching', () => ({
  loadInvoiceMatchPool: vi.fn(),
  matchInvoiceCandidates: vi.fn(),
}))

import { loadInvoiceMatchPool, matchInvoiceCandidates } from '@/lib/invoices/invoice-matching'

/** A scorer answer carrying only matches. */
const found = (matches: unknown[]) => ({ matches, unconvertedFxCount: 0, unconvertedFxInvoices: [] }) as never

describe('gnubok_auto_match_period: registration', () => {
  it('is registered', () => {
    const tool = tools.find((t) => t.name === 'gnubok_auto_match_period')
    expect(tool).toBeDefined()
    // Stages writes when dry_run=false, so not read-only
    expect(tool?.annotations.readOnlyHint).toBe(false)
    expect(tool?.annotations.destructiveHint).toBe(false)
  })

  it('requires date_from and date_to', () => {
    const tool = tools.find((t) => t.name === 'gnubok_auto_match_period')!
    const schema = tool.inputSchema as { required?: string[] }
    expect(schema.required).toContain('date_from')
    expect(schema.required).toContain('date_to')
  })

  it('is mapped to transactions:write scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_auto_match_period).toBe('transactions:write')
  })
})

/**
 * Build a mock that returns a fixed transactions array on the
 *   .from('transactions').select(...).eq(...).gte(...).lte(...).gt(...).is(...).is(...).order(...).limit(...)
 * call chain.
 */
function makeTxMock(transactions: unknown[]) {
  const result = { data: transactions, error: null }
  const buildChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          return () => buildChain()
        },
      },
    )
  return {
    from: vi.fn().mockImplementation(() => buildChain()),
  } as never
}

describe('gnubok_auto_match_period: dry run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns proposals at and above the confidence threshold, classifies the rest', async () => {
    const txs = [
      { id: 't1', date: '2026-03-01', amount: 1000, currency: 'SEK', description: 'Pay 1', merchant_name: null, reference: null, journal_entry_id: null, invoice_id: null },
      { id: 't2', date: '2026-03-02', amount: 500, currency: 'SEK', description: 'Pay 2', merchant_name: null, reference: null, journal_entry_id: null, invoice_id: null },
      { id: 't3', date: '2026-03-03', amount: 200, currency: 'SEK', description: 'Pay 3', merchant_name: null, reference: null, journal_entry_id: null, invoice_id: null },
    ]
    const supabase = makeTxMock(txs)

    const pool = { invoices: [] }
    vi.mocked(loadInvoiceMatchPool).mockResolvedValue(pool)
    vi.mocked(matchInvoiceCandidates)
      // t1: high confidence: should propose
      .mockReturnValueOnce(found([
        { invoice: { id: 'i1', invoice_number: 'INV-1', total: 1000, customer: { name: 'Acme' } }, confidence: 0.95, matchReason: 'Exakt belopp + kund' },
      ]))
      // t2: below threshold (0.7 < 0.9)
      .mockReturnValueOnce(found([
        { invoice: { id: 'i2', invoice_number: 'INV-2', total: 500, customer: { name: 'Foo' } }, confidence: 0.7, matchReason: 'Belopp matchar' },
      ]))
      // t3: no match
      .mockReturnValueOnce(found([]))

    const tool = tools.find((t) => t.name === 'gnubok_auto_match_period')!
    const result = (await tool.execute(
      {
        date_from: '2026-03-01',
        date_to: '2026-03-31',
        confidence_threshold: 0.9,
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase,
    )) as {
      dry_run: boolean
      scanned_transactions: number
      proposed_matches: number
      below_threshold: number
      no_match_found: number
      staged_count: number
      proposals: { decision: string; transaction_id: string; confidence: number }[]
    }

    expect(result.dry_run).toBe(true)
    expect(result.scanned_transactions).toBe(3)
    expect(result.proposed_matches).toBe(1)
    expect(result.below_threshold).toBe(1)
    expect(result.no_match_found).toBe(1)
    expect(result.staged_count).toBe(0)

    const decisions = result.proposals.map((p) => p.decision)
    expect(decisions).toContain('propose')
    expect(decisions).toContain('below_threshold')

    // The open invoices are read once for the period, every row scored against them.
    expect(loadInvoiceMatchPool).toHaveBeenCalledTimes(1)
    expect(loadInvoiceMatchPool).toHaveBeenCalledWith(supabase, 'company-1')
    expect(matchInvoiceCandidates).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(matchInvoiceCandidates).mock.calls) expect(call[1]).toBe(pool)
  })

  it('truncates when more transactions match than max_transactions', async () => {
    // Return 3 transactions when max_transactions=2 → truncated should be true.
    // The tool fetches max_transactions+1 to detect truncation.
    const txs = [
      { id: 't1', date: '2026-03-01', amount: 100, currency: 'SEK', description: '', merchant_name: null, reference: null, journal_entry_id: null, invoice_id: null },
      { id: 't2', date: '2026-03-02', amount: 100, currency: 'SEK', description: '', merchant_name: null, reference: null, journal_entry_id: null, invoice_id: null },
      { id: 't3', date: '2026-03-03', amount: 100, currency: 'SEK', description: '', merchant_name: null, reference: null, journal_entry_id: null, invoice_id: null },
    ]
    const supabase = makeTxMock(txs)
    vi.mocked(loadInvoiceMatchPool).mockResolvedValue({ invoices: [] })
    vi.mocked(matchInvoiceCandidates).mockReturnValue(found([]))

    const tool = tools.find((t) => t.name === 'gnubok_auto_match_period')!
    const result = (await tool.execute(
      {
        date_from: '2026-03-01',
        date_to: '2026-03-31',
        max_transactions: 2,
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase,
    )) as { truncated: boolean; scanned_transactions: number }

    expect(result.truncated).toBe(true)
    expect(result.scanned_transactions).toBe(2)
  })
})
