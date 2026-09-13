/**
 * gnubok_bulk_book_transactions: the two per-batch homogeneity refusals are
 * legal limits (BFL 5 kap 6 § tredje stycket: one gemensam verifikation only
 * for likartade affärshändelser on the same day). Read as technical limits
 * they led an agent to propose a monthly samlingsverifikat (feedback seq
 * 378710 / 382660), so the message must cite the statute and the split, and
 * carry the registry code so the envelope resolves to a remediation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const bulkBook = tools.find((t) => t.name === 'gnubok_bulk_book_transactions')!

async function stage(txRows: Array<Record<string, unknown>>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: txRows, error: null }) // transactions fetch (link-existing path: first query)
  return bulkBook.execute(
    { tx_ids: txRows.map((t) => t.id), existing_journal_entry_id: 'je-1' },
    'company-1',
    'user-1',
    supabase as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_bulk_book_transactions: BFL 5 kap 6 § refusals', () => {
  it('cites the statute and the per-day split when dates differ', async () => {
    const err = await stage([
      { id: 'tx-1', amount: -100, currency: 'SEK', date: '2026-05-12', journal_entry_id: null },
      { id: 'tx-2', amount: -200, currency: 'SEK', date: '2026-05-13', journal_entry_id: null },
    ]).catch((e: unknown) => e as Error & { code?: string })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('BFL 5 kap 6')
    expect((err as Error).message).toMatch(/likartade affärshändelser on the same day/)
    expect((err as Error).message).toMatch(/once per date/)
    expect((err as Error & { code?: string }).code).toBe('BULK_BOOK_DATE_MISMATCH')
  })

  it('cites the statute and the per-direction split when signs differ', async () => {
    const err = await stage([
      { id: 'tx-1', amount: -100, currency: 'SEK', date: '2026-05-12', journal_entry_id: null },
      { id: 'tx-2', amount: 250, currency: 'SEK', date: '2026-05-12', journal_entry_id: null },
    ]).catch((e: unknown) => e as Error & { code?: string })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('BFL 5 kap 6')
    expect((err as Error).message).toMatch(/once for the income rows and once for the expense rows/)
    expect((err as Error & { code?: string }).code).toBe('BULK_BOOK_DIRECTION_MISMATCH')
  })
})
