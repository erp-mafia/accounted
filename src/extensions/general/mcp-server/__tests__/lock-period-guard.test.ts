/**
 * gnubok_lock_period: the staging pre-check must enforce the SAME predicate
 * as the commit path (lockPeriod in lib/core/bookkeeping/period-service.ts).
 *
 * The old inline check (journal_entry_id IS NULL AND is_business = true) was
 * dead: triage is what sets is_business, so it never matched an untriaged
 * row, and bulk-booked transactions keep journal_entry_id NULL while anchored
 * via transaction_voucher_links, so it blocked on already-booked rows. An
 * agent could stage a lock over thousands of untriaged transactions and
 * present an approval card claiming zero unbooked (BFL 5 kap 2 §).
 *
 * The corrected guard counts:
 *   - untriaged: is_business IS NULL AND is_ignored = false
 *   - businessUnbooked: is_business = true, is_ignored = false,
 *     journal_entry_id IS NULL, minus rows anchored via
 *     transaction_voucher_links / invoice_payments / supplier_invoice_payments
 * and fails CLOSED when the check itself cannot run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const lockPeriod = tools.find((t) => t.name === 'gnubok_lock_period')!

const PERIOD = {
  id: 'fp-1',
  name: 'FY 2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_lock_period staging guard', () => {
  it('refuses to stage while untriaged transactions exist (the predicate the old check never matched)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: null, count: 3 }) // untriaged head-count
    enqueue({ data: [] }) // business candidates page (none)

    await expect(
      lockPeriod.execute(
        { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/Kan inte låsa period: 3 banktransaktion\(er\) i perioden saknar bokföring \(3 ej hanterade\)/)

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(fromCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })

  it('keeps the load-bearing phrases for both error-code matchers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 1 })
    enqueue({ data: [] })

    const err = await lockPeriod
      .execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    // Route regex: "saknar bokföring"; inferCode regex:
    // /Kan inte låsa period:.*affärstransaktion/ (same phrases the
    // period-service message carries).
    expect(err!.message).toMatch(/saknar bokföring/)
    expect(err!.message).toMatch(/Kan inte låsa period:.*affärstransaktion/)
  })

  it('refuses to stage over business-triaged rows with no verifikat anchor anywhere', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 0 }) // untriaged: none
    enqueue({ data: [{ id: 'tx-9' }] }) // business candidates
    enqueue({ data: [] }) // transaction_voucher_links
    enqueue({ data: [] }) // invoice_payments
    enqueue({ data: [] }) // supplier_invoice_payments

    await expect(
      lockPeriod.execute(
        { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/1 markerade som affärshändelse men utan verifikat/)
  })

  it('stages when the business candidates are anchored via transaction_voucher_links (bulk-booked rows no longer block)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 0 }) // untriaged: none
    // Two bulk-booked rows: journal_entry_id NULL but anchored via links. The
    // OLD predicate counted these and refused; the shared predicate subtracts
    // them.
    enqueue({ data: [{ id: 'tx-1' }, { id: 'tx-2' }] })
    enqueue({ data: [{ transaction_id: 'tx-1' }, { transaction_id: 'tx-2' }] }) // transaction_voucher_links
    enqueue({ data: [] }) // invoice_payments
    enqueue({ data: [] }) // supplier_invoice_payments
    enqueue({ data: { id: 'op-lock-1' } }) // pending_operations insert

    const result = (await lockPeriod.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-lock-1')
    expect(result.preview.unbooked_business_transactions).toBe(0)
    expect(result.preview.untriaged_transactions).toBe(0)
  })

  it('stages the clean period (no untriaged, no candidates)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 0 })
    enqueue({ data: [] }) // no business candidates: no anchor lookups run
    enqueue({ data: { id: 'op-lock-2' } }) // pending_operations insert

    const result = (await lockPeriod.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
  })

  it('fails CLOSED when the guard query errors: never stages, and the message steers to retry, not remediation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, error: { message: 'connection reset' }, count: null }) // untriaged count fails

    const err = await lockPeriod
      .execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/Kunde inte kontrollera obokförda banktransaktioner/)
    // Deliberately matches NEITHER remediation matcher: an unreachable DB
    // must not send an agent off booking transactions.
    expect(err!.message).not.toMatch(/saknar bokföring/)
    expect(err!.message).not.toMatch(/Kan inte låsa period/)

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(fromCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })
})
