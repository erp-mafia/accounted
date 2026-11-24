/**
 * Posting port, step 1: the engine's business event link.
 *
 * With CreateEntryOptions.businessEvent (and reverseEntry's option) the
 * engine writes the business_event_entries row right after the draft header
 * and before the lines and commit_journal_entry, so the voucher number is
 * drawn only after the link. Without it, the engine makes exactly the calls
 * it made before. A refused link under strict ('abort') cancels the
 * numberless draft and stops; under shadow ('log') and for a missing table
 * the posting goes ahead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { createDraftEntry, createJournalEntry, reverseEntry } from '../engine'
import { BookkeepingDatabaseError } from '../errors'
import type { BusinessEventLink } from '../business-event-link'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: vi.fn(async (_s: unknown, _c: string, original: { entry_date: string; fiscal_period_id: string }) => ({
    date: original.entry_date,
    fiscal_period_id: original.fiscal_period_id,
    moved: false,
  })),
}))
vi.mock('@/lib/core/bookkeeping/correction-chain', () => ({
  correctionChainDepth: vi.fn().mockResolvedValue({ depth: 0, rootVoucher: null }),
  CORRECTION_CHAIN_GUARD_DEPTH: 3,
}))

const ENTRY_ID = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'
const EVENT_ID = '7b3a0000-1111-4222-8333-444455556666'

const INPUT: CreateJournalEntryInput = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-03-14',
  description: 'Programvarulicens',
  source_type: 'bank_transaction',
  source_id: 'tx-1',
  voucher_series: 'A',
  lines: [
    { account_number: '5420', debit_amount: 1250, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
  ],
}

type LinkAnswer = { error?: { message: string; code?: string } }

const has = (chain: Parameters<TableMockResolver>[0], method: string) => chain.some((c) => c.method === method)

/** The engine's reads and writes for a draft and its commit. */
function draftMock(link: LinkAnswer = {}) {
  return createTableMockSupabase({
    account_dimension_rules: { data: [] },
    fiscal_periods: { data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } },
    chart_of_accounts: { data: [{ account_number: '5420', id: 'a1' }, { account_number: '1930', id: 'a2' }] },
    journal_entries: (chain) =>
      has(chain, 'insert')
        ? { data: { id: ENTRY_ID, status: 'draft' } }
        : has(chain, 'update')
          ? { data: null }
          : { data: { id: ENTRY_ID, status: 'posted', lines: [] } },
    business_event_entries: link,
    'rpc:commit_journal_entry': { data: { voucher_number: 7 } },
  })
}

/** Writes and RPCs in the order the engine made them: '<table>.<method>'. */
function writes(calls: { table: string; method: string }[]): string[] {
  return calls.filter((c) => ['insert', 'update', 'delete', 'rpc'].includes(c.method)).map((c) => `${c.table}.${c.method}`)
}

const WITHOUT_EVENT = [
  'journal_entries.insert',
  'journal_entry_lines.insert',
  'rpc:commit_journal_entry.rpc',
]

const link = (onFailure: BusinessEventLink['onFailure']): BusinessEventLink => ({ id: EVENT_ID, role: 'produced', onFailure })

describe('engine: the business event link (posting port)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('makes exactly the calls it made before when no event is passed', async () => {
    const { supabase, calls, tables } = draftMock()
    await createJournalEntry(supabase as never, 'company-1', 'user-1', INPUT)
    expect(writes(calls)).toEqual(WITHOUT_EVENT)
    expect(tables()).not.toContain('business_event_entries')
  })

  it('writes the link right after the draft header, before the lines and before the number is drawn', async () => {
    const { supabase, calls, payloads, tables } = draftMock()
    await createJournalEntry(supabase as never, 'company-1', 'user-1', INPUT, undefined, undefined, {
      businessEvent: link('abort'),
    })
    expect(writes(calls)).toEqual([
      'journal_entries.insert',
      'business_event_entries.insert',
      'journal_entry_lines.insert',
      'rpc:commit_journal_entry.rpc',
    ])
    expect(payloads('business_event_entries', 'insert')).toEqual([
      { business_event_id: EVENT_ID, journal_entry_id: ENTRY_ID, company_id: 'company-1', role: 'produced' },
    ])
    // Every other read is the one the engine makes without an event.
    const { supabase: plain, tables: plainTables } = draftMock()
    await createJournalEntry(plain as never, 'company-1', 'user-1', INPUT)
    expect(tables().filter((t) => t !== 'business_event_entries')).toEqual(plainTables())
  })

  it('shadow: a refused link is logged and the posting goes ahead', async () => {
    const { supabase, calls } = draftMock({ error: { message: 'boom', code: '23514' } })
    const entry = await createJournalEntry(supabase as never, 'company-1', 'user-1', INPUT, undefined, undefined, {
      businessEvent: link('log'),
    })
    expect(entry.id).toBe(ENTRY_ID)
    expect(writes(calls)).toEqual([
      'journal_entries.insert',
      'business_event_entries.insert',
      'journal_entry_lines.insert',
      'rpc:commit_journal_entry.rpc',
    ])
  })

  it('strict: a refused link cancels the numberless draft and stops before commit_journal_entry', async () => {
    const { supabase, calls, payloads } = draftMock({ error: { message: 'boom', code: '23514' } })
    const failure = await createJournalEntry(supabase as never, 'company-1', 'user-1', INPUT, undefined, undefined, {
      businessEvent: link('abort'),
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BookkeepingDatabaseError)
    expect((failure as BookkeepingDatabaseError).operation).toBe('link_business_event')
    expect(writes(calls)).toEqual(['journal_entries.insert', 'business_event_entries.insert', 'journal_entries.update'])
    expect(payloads('journal_entries', 'update')).toEqual([{ status: 'cancelled' }])
  })

  it('strict: a missing table (deploy order) is skipped and the posting goes ahead', async () => {
    for (const code of ['PGRST205', '42P01']) {
      const { supabase, calls } = draftMock({ error: { message: 'missing', code } })
      await createDraftEntry(supabase as never, 'company-1', 'user-1', INPUT, { businessEvent: link('abort') })
      expect(writes(calls)).toEqual(['journal_entries.insert', 'business_event_entries.insert', 'journal_entry_lines.insert'])
    }
  })

  describe('reverseEntry', () => {
    const ORIGINAL = {
      id: 'orig-1',
      company_id: 'company-1',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2026-03-14',
      description: 'Programvarulicens',
      source_type: 'bank_transaction',
      source_id: 'tx-1',
      status: 'posted',
      lines: [
        { account_number: '5420', debit_amount: 1250, credit_amount: 0, line_description: 'x', currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250, line_description: 'x', currency: 'SEK' },
      ],
    }
    function reverseMock(linkAnswer: LinkAnswer = {}) {
      let reads = 0
      return createTableMockSupabase({
        journal_entries: (chain) => {
          if (has(chain, 'insert')) return { data: { id: 'rev-1', status: 'draft' } }
          if (has(chain, 'update')) return { data: [{ id: 'orig-1' }] }
          reads += 1
          return { data: reads === 1 ? ORIGINAL : { id: 'rev-1', status: 'posted', lines: [] } }
        },
        chart_of_accounts: { data: [{ account_number: '5420', id: 'a1' }, { account_number: '1930', id: 'a2' }] },
        business_event_entries: linkAnswer,
        transaction_voucher_links: { data: [] },
      })
    }

    it('links the storno draft before its lines and before its number, with the role given', async () => {
      const { supabase, calls, payloads } = reverseMock()
      await reverseEntry(supabase as never, 'company-1', 'user-1', 'orig-1', undefined, {
        businessEvent: { id: EVENT_ID, role: 'reversal', onFailure: 'abort' },
      })
      expect(writes(calls).slice(0, 4)).toEqual([
        'journal_entries.insert',
        'business_event_entries.insert',
        'journal_entry_lines.insert',
        'rpc:commit_journal_entry.rpc',
      ])
      expect(payloads('business_event_entries', 'insert')).toEqual([
        { business_event_id: EVENT_ID, journal_entry_id: 'rev-1', company_id: 'company-1', role: 'reversal' },
      ])
    })

    it('makes no link call without the option', async () => {
      const { supabase, tables } = reverseMock()
      await reverseEntry(supabase as never, 'company-1', 'user-1', 'orig-1')
      expect(tables()).not.toContain('business_event_entries')
    })

    it('strict: a refused link cancels the storno draft before its number is drawn', async () => {
      const { supabase, calls, payloads } = reverseMock({ error: { message: 'boom' } })
      await expect(
        reverseEntry(supabase as never, 'company-1', 'user-1', 'orig-1', undefined, {
          businessEvent: { id: EVENT_ID, role: 'reversal', onFailure: 'abort' },
        }),
      ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
      expect(writes(calls)).toEqual(['journal_entries.insert', 'business_event_entries.insert', 'journal_entries.update'])
      expect(payloads('journal_entries', 'update')).toEqual([{ status: 'cancelled' }])
    })
  })
})
