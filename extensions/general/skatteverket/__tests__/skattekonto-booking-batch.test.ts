import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The batch loop delegates all journal writes to the engine: stub the three
// engine entry points so the tests exercise the batch/enrichment logic, not
// the engine's own chains (those are covered by the engine's tests).
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return {
    ...actual,
    findFiscalPeriod: vi.fn(),
    createDraftEntry: vi.fn(),
    commitEntry: vi.fn(),
  }
})

import { findFiscalPeriod, createDraftEntry, commitEntry } from '@/lib/bookkeeping/engine'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  attachBookingSuggestions,
  bokforSkattekontoTransactionsBatch,
} from '../lib/skattekonto-booking'

/**
 * System seeds mirror supabase/migrations/20260519100000_skattekonto_rules.sql
 * (same fixture as skattekonto-booking.test.ts).
 */
const SEED_RULES = [
  {
    id: 'sys-1', priority: 10, pattern: 'inbetalning bokförd,inbetalning,överföring från bank',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '__PRIMARY_SEK__', counter_account_ef: null,
    label: 'Inbetalning till skattekonto', active: true,
  },
  {
    id: 'sys-3', priority: 20, pattern: 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2510', counter_account_ef: '2012',
    label: 'Preliminär skatt', active: true,
  },
  {
    id: 'sys-8', priority: 30, pattern: 'kostnadsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8423', counter_account_ef: null,
    label: 'Kostnadsränta skattekonto', active: true,
  },
  {
    id: 'sys-9', priority: 30, pattern: 'intäktsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8314', counter_account_ef: null,
    label: 'Intäktsränta skattekonto', active: true,
  },
]

let rowSeq = 0
function makeSkvRow(overrides: Record<string, unknown> = {}) {
  rowSeq += 1
  return {
    id: `row-${rowSeq}`,
    company_id: 'company-1',
    transaktionstext: 'Intäktsränta',
    transaktionsdatum: '2026-01-15',
    belopp_skatteverket: 1,
    status: 'booked',
    journal_entry_id: null,
    ...overrides,
  }
}

function makeSupabase() {
  return createQueuedMockSupabase()
}

/** Number of times a table was targeted by supabase.from(). */
function fromCount(
  supabase: ReturnType<typeof makeSupabase>['supabase'],
  table: string,
): number {
  return supabase.from.mock.calls.filter((c: unknown[]) => c[0] === table).length
}

beforeEach(() => {
  vi.clearAllMocks()
  rowSeq = 0
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createDraftEntry).mockImplementation(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ id: 'je-draft-1' }) as any,
  )
  vi.mocked(commitEntry).mockImplementation(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ id: 'je-draft-1', voucher_number: 42, voucher_series: 'A' }) as any,
  )
})

describe('attachBookingSuggestions', () => {
  it('attaches account, BAS name and rule label on a rule match', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES }) // skattekonto_rules
    enqueue({ data: { entity_type: 'aktiebolag' } }) // company_settings

    const rows = [makeSkvRow({ transaktionstext: 'Intäktsränta' })]
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      rows,
    )

    expect(enriched[0].booking_suggestion).toEqual({
      account: '8314',
      account_name: getBASReference('8314')?.account_name ?? null,
      label: 'Intäktsränta skattekonto',
    })
  })

  it('resolves EF-specific counter accounts from the hoisted entity_type', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'enskild_firma' } })

    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt' })],
    )
    expect(enriched[0].booking_suggestion?.account).toBe('2012')

    const ab = makeSupabase()
    ab.enqueue({ data: SEED_RULES })
    ab.enqueue({ data: { entity_type: 'aktiebolag' } })
    const enrichedAb = await attachBookingSuggestions(
      ab.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt' })],
    )
    expect(enrichedAb[0].booking_suggestion?.account).toBe('2510')
  })

  it('returns null when no rule matches', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })

    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Något helt okänt' })],
    )
    expect(enriched[0].booking_suggestion).toBeNull()
  })

  it('hoists the rules fetch: one skattekonto_rules query for many rows', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })

    const rows = [
      makeSkvRow({ transaktionstext: 'Intäktsränta' }),
      makeSkvRow({ transaktionstext: 'Kostnadsränta' }),
      makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt' }),
    ]
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      rows,
    )

    expect(enriched.map((r) => r.booking_suggestion?.account)).toEqual([
      '8314',
      '8423',
      '2510',
    ])
    expect(fromCount(supabase, 'skattekonto_rules')).toBe(1)
    expect(fromCount(supabase, 'company_settings')).toBe(1)
  })

  it('resolves the __PRIMARY_SEK__ sentinel once via cash_accounts', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { ledger_account: '1932' } }) // cash_accounts primary

    const rows = [
      makeSkvRow({ transaktionstext: 'Inbetalning bokförd 240412' }),
      makeSkvRow({ transaktionstext: 'Inbetalning bokförd 240513' }),
    ]
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      rows,
    )

    expect(enriched[0].booking_suggestion?.account).toBe('1932')
    expect(enriched[1].booking_suggestion?.account).toBe('1932')
    // Memoized: the second sentinel row must not refetch cash_accounts.
    expect(fromCount(supabase, 'cash_accounts')).toBe(1)
  })

  it('gives booked rows null without any fetches when nothing needs a suggestion', async () => {
    const { supabase } = makeSupabase()
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ journal_entry_id: 'je-9' }), makeSkvRow({ status: 'upcoming' })],
    )
    expect(enriched.every((r) => r.booking_suggestion === null)).toBe(true)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('bokforSkattekontoTransactionsBatch', () => {
  it('books each row, commits per row, and never aborts on a row failure', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row1 = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    const row2 = makeSkvRow({ transaktionstext: 'Ingen regel matchar detta' })
    const row3 = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -100 })

    enqueue({ data: SEED_RULES }) // hoisted rules
    enqueue({ data: { entity_type: 'aktiebolag' } }) // hoisted entity_type
    enqueue({ data: row1 }) // tx fetch row1
    enqueue({ data: null }) // journal_entry_id writeback row1
    enqueue({ data: row2 }) // tx fetch row2 (fails matching, no writeback)
    enqueue({ data: row3 }) // tx fetch row3
    enqueue({ data: null }) // writeback row3

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row1.id, row2.id, row3.id],
    )

    expect(result.results).toHaveLength(3)
    expect(result.results[0]).toMatchObject({
      id: row1.id,
      ok: true,
      journal_entry_id: 'je-draft-1',
      voucher_number: 42,
      voucher_series: 'A',
    })
    expect(result.results[1]).toMatchObject({
      id: row2.id,
      ok: false,
      error_code: 'NO_COUNTER_ACCOUNT',
    })
    expect(result.results[2]).toMatchObject({ id: row3.id, ok: true })
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1 })

    // Commit runs once per successful row, attributed as a bulk acceptance.
    expect(vi.mocked(commitEntry)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(commitEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-draft-1',
      'bulk_accept',
    )
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(2)
  })

  it('hoists rules/entity_type: one fetch each for the whole batch', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row1 = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    const row2 = makeSkvRow({ transaktionstext: 'Kostnadsränta' })

    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row1 })
    enqueue({ data: null })
    enqueue({ data: row2 })
    enqueue({ data: null })

    await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row1.id, row2.id],
    )

    expect(fromCount(supabase, 'skattekonto_rules')).toBe(1)
    expect(fromCount(supabase, 'company_settings')).toBe(1)
  })

  it('attributes a one-row batch as user_accept', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: null })

    await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(vi.mocked(commitEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-draft-1',
      'user_accept',
    )
  })

  it('reports COMMIT_FAILED with the kept draft id when the commit throws', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: null })

    vi.mocked(commitEntry).mockRejectedValueOnce(new Error('Bokföringen är låst'))

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'COMMIT_FAILED',
      journal_entry_id: 'je-draft-1',
      error_message: 'Bokföringen är låst',
    })
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
  })

  it('reports ALREADY_BOOKED for rows that already carry a journal entry', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ journal_entry_id: 'je-existing' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'ALREADY_BOOKED',
    })
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })
})
