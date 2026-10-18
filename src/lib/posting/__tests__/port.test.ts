/**
 * The posting port: off changes nothing, shadow records and never blocks,
 * strict stops before anything is drafted (so before a voucher number), and
 * the producer's input reaches the adapter as the same object.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { createPostingPort } from '../port'
import type { BusinessEventDraft, PostingAdapter } from '../types'
import type { PostingEventsMode } from '../mode'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const TX = '22222222-2222-4222-8222-222222222222'
const EVENT_ID = '33333333-3333-4333-8333-333333333333'
const EXISTING_ID = '44444444-4444-4444-8444-444444444444'
const OP = '55555555-5555-4555-8555-555555555555'

const INPUT: CreateJournalEntryInput = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-03-14',
  description: 'Programvarulicens',
  source_type: 'bank_transaction',
  source_id: TX,
  lines: [
    { account_number: '5420', debit_amount: 1000, credit_amount: 0 },
    { account_number: '2641', debit_amount: 250, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
  ],
}

const EVENT: BusinessEventDraft = {
  kind: 'bank.categorized',
  category: 'expense.software',
  occurredOn: '2026-03-14',
  subject: { type: 'transaction', id: TX },
  currency: 'SEK',
  amount: 1250,
  amountSek: 1250,
  taxAmounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 250 }],
  evidence: { direction: 'out', link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP } },
  pendingOperationId: OP,
  mappingVersion: 'se.category-mapping@bank-proposals.1+abc',
}

type InsertResult = { error: { message: string; code?: string } | null }

function fakeSupabase(insert: () => InsertResult, existing: { id: string } | null = null) {
  const inserted: unknown[] = []
  const from = vi.fn((_table: string) => ({
    insert: vi.fn(async (row: unknown) => {
      inserted.push(row)
      return insert()
    }),
    select: vi.fn(() => {
      const chain = {
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({ data: existing, error: null })),
      }
      return chain
    }),
  }))
  return { supabase: { from } as never, from, inserted }
}

type CreateArgs = Parameters<PostingAdapter['createJournalEntry']>[0]
type SetArgs = Parameters<PostingAdapter['createJournalEntries']>[0]
type DraftArgs = Parameters<PostingAdapter['createDraftEntry']>[0]
type CommitArgs = Parameters<PostingAdapter['commitEntry']>[0]
type ReverseArgs = Parameters<PostingAdapter['reverseEntry']>[0]
type CorrectArgs = Parameters<PostingAdapter['correctEntry']>[0]

function fakeAdapter() {
  const entry = { id: 'je-1' } as JournalEntry
  const adapter = {
    id: 'ledger' as const,
    createJournalEntry: vi.fn(async (_args: CreateArgs) => entry),
    createJournalEntries: vi.fn(async (args: SetArgs) => args.inputs.map((_, i) => ({ id: `je-set-${i + 1}` }) as JournalEntry)),
    createDraftEntry: vi.fn(async (_args: DraftArgs) => entry),
    commitEntry: vi.fn(async (_args: CommitArgs) => entry),
    reverseEntry: vi.fn(async (_args: ReverseArgs) => entry),
    correctEntry: vi.fn(async (_args: CorrectArgs) => ({ reversal: { id: 'je-storno' } as JournalEntry, corrected: { id: 'je-correction' } as JournalEntry })),
  } satisfies PostingAdapter
  return adapter
}

/** The argument object of the adapter call at `index`, as a plain record. */
function callArgs(fn: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  return fn.mock.calls[index]![0] as Record<string, unknown>
}

function port(mode: PostingEventsMode, adapter: PostingAdapter) {
  return createPostingPort({ adapter, mode: () => mode, newId: () => EVENT_ID })
}

describe('posting port', () => {
  beforeEach(() => vi.clearAllMocks())

  it('off: hands the producer\'s input to the adapter as the same object and touches nothing else', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    await port('off', adapter).postJournalEntry({
      supabase, companyId: COMPANY, userId: 'user-1', event: EVENT, input: INPUT, rubricVersion: 'r1',
    })
    expect(from).not.toHaveBeenCalled()
    expect(adapter.createJournalEntry).toHaveBeenCalledTimes(1)
    const args = callArgs(adapter.createJournalEntry, 0)
    expect(args.input).toBe(INPUT)
    expect(args.businessEvent).toBeUndefined()
    expect(args).toMatchObject({ companyId: COMPANY, userId: 'user-1', rubricVersion: 'r1' })
  })

  it('shadow: records the event first, then posts with the link (log on failure)', async () => {
    const adapter = fakeAdapter()
    const { supabase, from, inserted } = fakeSupabase(() => ({ error: null }))
    await runWithActor({ type: 'api_key', label: 'Bokföringsagent' }, () =>
      port('shadow', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'user-1', event: EVENT, input: INPUT }),
    )
    expect(from).toHaveBeenCalledWith('business_events')
    expect(inserted).toEqual([
      {
        id: EVENT_ID,
        company_id: COMPANY,
        kind: 'bank.categorized',
        category: 'expense.software',
        occurred_on: '2026-03-14',
        subject_type: 'transaction',
        subject_id: TX,
        party_type: null,
        party_id: null,
        currency: 'SEK',
        amount: 1250,
        amount_sek: 1250,
        tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 250 }],
        evidence: { direction: 'out', link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP } },
        receipt_id: null,
        pending_operation_id: OP,
        actor_type: 'api_key',
        actor_label: 'Bokföringsagent',
        mapping_version: 'se.category-mapping@bank-proposals.1+abc',
        jurisdiction: 'SE',
        idempotency_key: null,
      },
    ])
    const args = callArgs(adapter.createJournalEntry, 0)
    expect(args.input).toBe(INPUT)
    expect(args.businessEvent).toEqual({ id: EVENT_ID, role: 'produced', onFailure: 'log' })
  })

  it('shadow: a failed event write is logged and the posting goes ahead without a link', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'connection reset', code: '08006' } }))
    const entry = await port('shadow', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT })
    expect(entry.id).toBe('je-1')
    expect(callArgs(adapter.createJournalEntry, 0).businessEvent).toBeUndefined()
  })

  it('shadow: an event outside the closed lists is logged and the posting goes ahead', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    await port('shadow', adapter).postJournalEntry({
      supabase, companyId: COMPANY, userId: 'u', event: { ...EVENT, category: 'expense.made_up' as never }, input: INPUT,
    })
    expect(from).not.toHaveBeenCalled()
    expect(adapter.createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('strict: a failed event write stops the posting before the adapter drafts anything', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'permission denied', code: '42501' } }))
    const failure = await port('strict', adapter)
      .postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BookkeepingDatabaseError)
    expect((failure as BookkeepingDatabaseError).operation).toBe('record_business_event')
    expect((failure as BookkeepingDatabaseError).pgCode).toBe('42501')
    expect(adapter.createJournalEntry).not.toHaveBeenCalled()
  })

  it('strict: an invalid event stops the posting, and the link carries abort', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: null }))
    await expect(
      port('strict', adapter).postJournalEntry({
        supabase, companyId: COMPANY, userId: 'u', event: { ...EVENT, amount: -1250 }, input: INPUT,
      }),
    ).rejects.toThrow(/POSTING_EVENT_INVALID/)
    expect(adapter.createJournalEntry).not.toHaveBeenCalled()

    await port('strict', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT })
    expect(callArgs(adapter.createJournalEntry, 0).businessEvent).toEqual({
      id: EVENT_ID,
      role: 'produced',
      onFailure: 'abort',
    })
  })

  it('a missing table (deploy order) is skipped in shadow and strict alike', async () => {
    for (const mode of ['shadow', 'strict'] as const) {
      for (const code of ['PGRST205', '42P01']) {
        const adapter = fakeAdapter()
        const { supabase } = fakeSupabase(() => ({ error: { message: 'missing', code } }))
        await port(mode, adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT })
        expect(callArgs(adapter.createJournalEntry, 0).businessEvent).toBeUndefined()
      }
    }
  })

  it('records no event for lines the engine will refuse on its own checks', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    const unbalanced = { ...INPUT, lines: [{ account_number: '5420', debit_amount: 10, credit_amount: 0 }] }
    await port('strict', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: unbalanced })
    expect(from).not.toHaveBeenCalled()
    // The engine refuses it as it always has.
    expect(callArgs(adapter.createJournalEntry, 0).input).toBe(unbalanced)
  })

  it('a retry is the same event: a unique violation on the id, or on the idempotency key, links the row already there', async () => {
    const adapter = fakeAdapter()
    const conflict = () => ({ error: { message: 'duplicate key', code: '23505' } })
    const byId = fakeSupabase(conflict)
    await port('shadow', adapter).postJournalEntry({
      supabase: byId.supabase, companyId: COMPANY, userId: 'u', event: { ...EVENT, id: EVENT_ID }, input: INPUT,
    })
    expect(callArgs(adapter.createJournalEntry, 0).businessEvent).toMatchObject({ id: EVENT_ID })

    const byKey = fakeSupabase(conflict, { id: EXISTING_ID })
    await port('shadow', adapter).postJournalEntry({
      supabase: byKey.supabase, companyId: COMPANY, userId: 'u', event: { ...EVENT, idempotencyKey: 'import:job-1' }, input: INPUT,
    })
    expect(callArgs(adapter.createJournalEntry, 1).businessEvent).toMatchObject({ id: EXISTING_ID })
  })

  it('reverses through the adapter with the reversal role', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: null }))
    await port('shadow', adapter).reverseJournalEntry({
      supabase, companyId: COMPANY, userId: 'u', entryId: 'je-1', event: { ...EVENT, kind: 'ledger.storno' },
    })
    expect(callArgs(adapter.reverseEntry, 0)).toMatchObject({
      entryId: 'je-1',
      businessEvent: { id: EVENT_ID, role: 'reversal', onFailure: 'log' },
    })
    await port('off', adapter).reverseJournalEntry({ supabase, companyId: COMPANY, userId: 'u', entryId: 'je-1', event: EVENT })
    expect(callArgs(adapter.reverseEntry, 1).businessEvent).toBeUndefined()
  })
})

describe('posting port: a producer that drafts and commits itself', () => {
  it('off: drafts and commits with the producer\'s arguments and writes nothing else', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    const build = vi.fn(() => EVENT)
    await port('off', adapter).draftJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: build, input: INPUT })
    await port('off', adapter).commitJournalEntry({ supabase, companyId: COMPANY, userId: 'u', entryId: 'je-1' })
    expect(build).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    expect(callArgs(adapter.createDraftEntry, 0).input).toBe(INPUT)
    expect(callArgs(adapter.createDraftEntry, 0).businessEvent).toBeUndefined()
    expect(callArgs(adapter.commitEntry, 0)).toMatchObject({ entryId: 'je-1', commitMethod: undefined, rubricVersion: undefined })
  })

  it('shadow: records the event before the draft, links it to the draft, and the commit records nothing more', async () => {
    const adapter = fakeAdapter()
    const { supabase, inserted } = fakeSupabase(() => ({ error: null }))
    await port('shadow', adapter).draftJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT })
    expect(inserted).toHaveLength(1)
    expect(callArgs(adapter.createDraftEntry, 0).businessEvent).toEqual({ id: EVENT_ID, role: 'produced', onFailure: 'log' })
    await port('shadow', adapter).commitJournalEntry({ supabase, companyId: COMPANY, userId: 'u', entryId: 'je-1' })
    expect(inserted).toHaveLength(1)
  })

  it('shadow drafts through a refused event write; strict stops before the draft', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'refused', code: '42501' } }))
    await port('shadow', adapter).draftJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT })
    expect(callArgs(adapter.createDraftEntry, 0).businessEvent).toBeUndefined()
    await expect(
      port('strict', adapter).draftJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, input: INPUT }),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(adapter.createDraftEntry).toHaveBeenCalledTimes(1)
  })
})

describe('posting port: a set of verifikat that is one business act (postJournalEntrySet)', () => {
  const SET: CreateJournalEntryInput[] = [
    INPUT,
    { ...INPUT, description: 'Arbetsgivaravgifter', lines: [
      { account_number: '7510', debit_amount: 314.2, credit_amount: 0 },
      { account_number: '2731', debit_amount: 0, credit_amount: 314.2 },
    ] },
  ]

  it('off: hands the inputs to the adapter as the same array, builds no event and writes nothing else', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    const build = vi.fn(() => EVENT)
    const posted = await port('off', adapter).postJournalEntrySet({ supabase, companyId: COMPANY, userId: 'u', event: build, inputs: SET })
    expect(posted.map((e) => e.id)).toEqual(['je-set-1', 'je-set-2'])
    expect(build).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    const args = callArgs(adapter.createJournalEntries, 0)
    expect(args.inputs).toBe(SET)
    expect(args.businessEvent).toBeUndefined()
  })

  it('shadow: records ONE event for the set and hands its link to the adapter for every draft', async () => {
    const adapter = fakeAdapter()
    const { supabase, inserted } = fakeSupabase(() => ({ error: null }))
    await port('shadow', adapter).postJournalEntrySet({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, inputs: SET })
    expect(inserted).toHaveLength(1)
    expect(adapter.createJournalEntries).toHaveBeenCalledTimes(1)
    expect(callArgs(adapter.createJournalEntries, 0).businessEvent).toEqual({ id: EVENT_ID, role: 'produced', onFailure: 'log' })
  })

  it('a resumed set links to the event an earlier attempt recorded (idempotency key)', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'duplicate key', code: '23505' } }), { id: EXISTING_ID })
    await port('strict', adapter).postJournalEntrySet({
      supabase, companyId: COMPANY, userId: 'u', event: { ...EVENT, idempotencyKey: 'payroll.salary_paid:salary_run:x' }, inputs: SET,
    })
    expect(callArgs(adapter.createJournalEntries, 0).businessEvent).toEqual({ id: EXISTING_ID, role: 'produced', onFailure: 'abort' })
  })

  it('shadow posts the set through a refused event write; strict stops before the adapter drafts anything', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'refused', code: '42501' } }))
    const posted = await port('shadow', adapter).postJournalEntrySet({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, inputs: SET })
    expect(posted).toHaveLength(2)
    expect(callArgs(adapter.createJournalEntries, 0).businessEvent).toBeUndefined()
    await expect(
      port('strict', adapter).postJournalEntrySet({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, inputs: SET }),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(adapter.createJournalEntries).toHaveBeenCalledTimes(1)
  })

  it('an empty set (every voucher adopted) and a set the engine will refuse record no event', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    await port('strict', adapter).postJournalEntrySet({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, inputs: [] })
    const unbalanced = [INPUT, { ...INPUT, lines: [{ account_number: '7510', debit_amount: 1, credit_amount: 0 }] }]
    await port('strict', adapter).postJournalEntrySet({ supabase, companyId: COMPANY, userId: 'u', event: EVENT, inputs: unbalanced })
    expect(from).not.toHaveBeenCalled()
    expect(callArgs(adapter.createJournalEntries, 0)).toMatchObject({ inputs: [], businessEvent: undefined })
    expect(callArgs(adapter.createJournalEntries, 1).inputs).toBe(unbalanced)
  })
})

describe('posting port: a lazily built event', () => {
  it('is never built while the port is off, and a throwing builder is a shadow failure, not a lost posting', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: null }))
    const build = vi.fn((): BusinessEventDraft => {
      throw new Error('builder bug')
    })
    await port('off', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: build, input: INPUT })
    expect(build).not.toHaveBeenCalled()

    const entry = await port('shadow', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: build, input: INPUT })
    expect(build).toHaveBeenCalledTimes(1)
    expect(entry.id).toBe('je-1')
    expect(callArgs(adapter.createJournalEntry, 1).businessEvent).toBeUndefined()

    await expect(
      port('strict', adapter).postJournalEntry({ supabase, companyId: COMPANY, userId: 'u', event: build, input: INPUT }),
    ).rejects.toThrow('builder bug')
    expect(adapter.createJournalEntry).toHaveBeenCalledTimes(2)
  })
})

describe('posting port: an event linked to no verifikat (recordEvent, an import job)', () => {
  const JOB = '66666666-6666-4666-8666-666666666666'
  const JOB_EVENT: BusinessEventDraft = {
    kind: 'ledger.history_import',
    occurredOn: '2026-10-18',
    subject: { type: 'sie_import', id: JOB },
    evidence: { link_basis: 'import_carried_over', file_hash: 'a'.repeat(64), voucher_count: 4 },
    idempotencyKey: `ledger.history_import:sie_import:${JOB}`,
  }

  function adapterUntouched(adapter: ReturnType<typeof fakeAdapter>) {
    for (const fn of [adapter.createJournalEntry, adapter.createJournalEntries, adapter.createDraftEntry, adapter.commitEntry, adapter.reverseEntry]) {
      expect(fn).not.toHaveBeenCalled()
    }
  }

  it('off: builds nothing, writes nothing and answers null', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    const build = vi.fn(() => JOB_EVENT)
    expect(await port('off', adapter).recordEvent({ supabase, companyId: COMPANY, event: build })).toBeNull()
    expect(build).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    adapterUntouched(adapter)
  })

  it('shadow: writes the one event and answers its id; the adapter posts nothing', async () => {
    const adapter = fakeAdapter()
    const { supabase, inserted } = fakeSupabase(() => ({ error: null }))
    expect(await port('shadow', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT })).toBe(EVENT_ID)
    expect(inserted).toEqual([
      expect.objectContaining({
        id: EVENT_ID,
        company_id: COMPANY,
        kind: 'ledger.history_import',
        subject_type: 'sie_import',
        subject_id: JOB,
        amount: null,
        evidence: { link_basis: 'import_carried_over', file_hash: 'a'.repeat(64), voucher_count: 4 },
        idempotency_key: `ledger.history_import:sie_import:${JOB}`,
      }),
    ])
    adapterUntouched(adapter)
  })

  it('a retried job answers the event its first attempt recorded (idempotency key)', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'duplicate key', code: '23505' } }), { id: EXISTING_ID })
    expect(await port('strict', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT })).toBe(EXISTING_ID)
  })

  it('shadow answers null through a refused write; strict throws', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'refused', code: '42501' } }))
    expect(await port('shadow', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT })).toBeNull()
    await expect(port('strict', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT })).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
    const missing = fakeSupabase(() => ({ error: { message: 'relation "business_events" does not exist', code: '42P01' } }))
    expect(await port('strict', adapter).recordEvent({ supabase: missing.supabase, companyId: COMPANY, event: JOB_EVENT })).toBeNull()
    adapterUntouched(adapter)
  })

  it('names the actor it is given (null for none) instead of the surrounding scope', async () => {
    const adapter = fakeAdapter()
    const { supabase, inserted } = fakeSupabase(() => ({ error: null }))
    await runWithActor({ type: 'cron', label: 'SIE worker' }, async () => {
      await port('shadow', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT, actor: { type: 'api_key', label: 'SIE import: Byrån' } })
      await port('shadow', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT, actor: null })
      await port('shadow', adapter).recordEvent({ supabase, companyId: COMPANY, event: JOB_EVENT })
    })
    expect(inserted.map((row) => {
      const r = row as { actor_type: string | null; actor_label: string | null }
      return [r.actor_type, r.actor_label]
    })).toEqual([
      ['api_key', 'SIE import: Byrån'],
      [null, null],
      ['cron', 'SIE worker'],
    ])
  })
})

describe('posting port: a correction, two verifikat and two events (correctJournalEntry)', () => {
  const ORIGINAL = '66666666-6666-4666-8666-666666666666'
  const STORNO_EVENT: BusinessEventDraft = {
    kind: 'ledger.storno',
    occurredOn: '2026-10-18',
    subject: { type: 'journal_entry', id: ORIGINAL },
    evidence: { link_basis: 'user_created' },
  }
  const CORRECTION_EVENT: BusinessEventDraft = { ...STORNO_EVENT, kind: 'ledger.correction' }
  const LINES = INPUT.lines
  const ids = ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772']

  function correctionPort(mode: PostingEventsMode, adapter: PostingAdapter) {
    let n = 0
    return createPostingPort({ adapter, mode: () => mode, newId: () => ids[n++]! })
  }

  it('off: builds no event and hands the storno service its own arguments as the same objects', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    const stornoEvent = vi.fn(() => STORNO_EVENT)
    const correctionEvent = vi.fn(() => CORRECTION_EVENT)
    const correction = { lines: LINES, options: { description: 'Rättelse', allowDeepChain: true } }
    const result = await correctionPort('off', adapter).correctJournalEntry({
      supabase, companyId: COMPANY, userId: 'u', entryId: ORIGINAL, stornoEvent, correctionEvent, correction,
    })
    expect(result.corrected.id).toBe('je-correction')
    expect(stornoEvent).not.toHaveBeenCalled()
    expect(correctionEvent).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    const args = callArgs(adapter.correctEntry, 0)
    expect(args.correction).toBe(correction)
    expect(args.businessEvents).toBeUndefined()
    expect(args).toMatchObject({ companyId: COMPANY, userId: 'u', entryId: ORIGINAL })
  })

  it('shadow: records the storno\'s and the correction\'s events first, each linked by its own role', async () => {
    const adapter = fakeAdapter()
    const { supabase, inserted } = fakeSupabase(() => ({ error: null }))
    await correctionPort('shadow', adapter).correctJournalEntry({
      supabase, companyId: COMPANY, userId: 'u', entryId: ORIGINAL, stornoEvent: STORNO_EVENT, correctionEvent: () => CORRECTION_EVENT,
      correction: { newDate: '2025-10-18' },
    })
    expect(inserted.map((row) => (row as { kind: string }).kind)).toEqual(['ledger.storno', 'ledger.correction'])
    expect(callArgs(adapter.correctEntry, 0).businessEvents).toEqual({
      reversal: { id: ids[0], role: 'reversal', onFailure: 'log' },
      correction: { id: ids[1], role: 'correction', onFailure: 'log' },
    })
  })

  it('shadow corrects through a refused event write; strict stops before the storno service writes anything', async () => {
    const adapter = fakeAdapter()
    const { supabase } = fakeSupabase(() => ({ error: { message: 'refused', code: '42501' } }))
    await correctionPort('shadow', adapter).correctJournalEntry({
      supabase, companyId: COMPANY, userId: 'u', entryId: ORIGINAL, stornoEvent: STORNO_EVENT, correctionEvent: CORRECTION_EVENT,
      correction: { lines: LINES },
    })
    expect(callArgs(adapter.correctEntry, 0).businessEvents).toBeUndefined()
    await expect(
      correctionPort('strict', adapter).correctJournalEntry({
        supabase, companyId: COMPANY, userId: 'u', entryId: ORIGINAL, stornoEvent: STORNO_EVENT, correctionEvent: CORRECTION_EVENT,
        correction: { lines: LINES },
      }),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(adapter.correctEntry).toHaveBeenCalledTimes(1)
  })

  it('records no event for lines the storno service refuses on its own (unbalanced)', async () => {
    const adapter = fakeAdapter()
    const { supabase, from } = fakeSupabase(() => ({ error: null }))
    await correctionPort('strict', adapter).correctJournalEntry({
      supabase, companyId: COMPANY, userId: 'u', entryId: ORIGINAL, stornoEvent: STORNO_EVENT, correctionEvent: CORRECTION_EVENT,
      correction: { lines: [{ account_number: '1930', debit_amount: 1, credit_amount: 0 }] },
    })
    expect(from).not.toHaveBeenCalled()
    expect(callArgs(adapter.correctEntry, 0).businessEvents).toBeUndefined()
  })
})
