import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput } from '@/types'
import type { AccountDimensionRule } from '../dimension-rules'

const logged = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: logged.error,
    child: vi.fn().mockReturnThis(),
  }),
}))

vi.mock('../engine', () => ({
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  cancelDraftEntry: vi.fn(),
}))

vi.mock('../dimension-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dimension-rules')>()),
  fetchActiveDimensionRules: vi.fn(),
}))

import { cancelDraftEntry, commitEntry, createDraftEntry } from '../engine'
import { fetchActiveDimensionRules } from '../dimension-rules'
import { DimensionValidationError, MandatoryDimensionMissingError } from '../dimension-errors'
import { createJournalEntries } from '../journal-entry-batch'

const supabase = {} as never

function voucher(description: string, accounts: [string, string], extra: Partial<CreateJournalEntryInput> = {}): CreateJournalEntryInput {
  return {
    fiscal_period_id: 'fp-1',
    entry_date: '2026-06-25',
    description,
    source_type: 'salary_payment',
    source_id: 'run-1',
    voucher_series: 'L',
    lines: [
      { account_number: accounts[0], debit_amount: 100, credit_amount: 0 },
      { account_number: accounts[1], debit_amount: 0, credit_amount: 100 },
    ],
    ...extra,
  }
}

const requiredProjectOn = (account: string): AccountDimensionRule => ({
  account_number: account,
  rule_type: 'required',
  sie_dim_no: '6',
  dimension_name: 'Projekt',
  value_code: null,
})

const SET = [
  voucher('Lön', ['7210', '1930']),
  voucher('Lön: Arbetsgivaravgifter', ['7510', '2731']),
  voucher('Lön: Semesteravsättning', ['7290', '2920']),
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchActiveDimensionRules).mockResolvedValue([])
  vi.mocked(createDraftEntry).mockImplementation(async (_s, _c, _u, input) => ({
    id: `draft-${input.description}`,
    status: 'draft',
    voucher_number: 0,
  }) as never)
  vi.mocked(commitEntry).mockImplementation(async (_s, _c, _u, id) => ({
    id,
    status: 'posted',
    voucher_number: 1,
  }) as never)
  vi.mocked(cancelDraftEntry).mockResolvedValue({} as never)
})

describe('createJournalEntries: one business event, all vouchers or none', () => {
  it('drafts every voucher before committing the first, then commits in order', async () => {
    const posted = await createJournalEntries(supabase, 'co-1', 'user-1', SET)

    expect(posted.map((entry) => entry.id)).toEqual([
      'draft-Lön',
      'draft-Lön: Arbetsgivaravgifter',
      'draft-Lön: Semesteravsättning',
    ])
    expect(vi.mocked(commitEntry).mock.calls.map((call) => call[3])).toEqual(posted.map((entry) => entry.id))
    expect(Math.max(...vi.mocked(createDraftEntry).mock.invocationCallOrder)).toBeLessThan(
      Math.min(...vi.mocked(commitEntry).mock.invocationCallOrder),
    )
    expect(cancelDraftEntry).not.toHaveBeenCalled()
  })

  it('posts nothing for an empty set', async () => {
    await expect(createJournalEntries(supabase, 'co-1', 'user-1', [])).resolves.toEqual([])
    expect(fetchActiveDimensionRules).not.toHaveBeenCalled()
    expect(createDraftEntry).not.toHaveBeenCalled()
  })

  it('a required dimension missing on the second voucher refuses the set before anything is drafted', async () => {
    vi.mocked(fetchActiveDimensionRules).mockResolvedValue([requiredProjectOn('7510')])

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', SET)).rejects.toBeInstanceOf(
      MandatoryDimensionMissingError,
    )
    expect(createDraftEntry).not.toHaveBeenCalled()
    expect(commitEntry).not.toHaveBeenCalled()
  })

  it('one refusal names every missing value across the set', async () => {
    vi.mocked(fetchActiveDimensionRules).mockResolvedValue([requiredProjectOn('7210'), requiredProjectOn('2920')])

    const error = await createJournalEntries(supabase, 'co-1', 'user-1', SET).catch((err: unknown) => err)

    expect((error as MandatoryDimensionMissingError).violations.map((v) => v.account_number)).toEqual([
      '7210',
      '2920',
    ])
  })

  it('checks the lines as the engine will store them: a default rule satisfies a required one', async () => {
    vi.mocked(fetchActiveDimensionRules).mockResolvedValue([
      requiredProjectOn('7510'),
      { ...requiredProjectOn('7510'), rule_type: 'default', value_code: 'P001' },
    ])

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', SET)).resolves.toHaveLength(3)
  })

  it('a tagged line satisfies the rule', async () => {
    vi.mocked(fetchActiveDimensionRules).mockResolvedValue([requiredProjectOn('7510')])
    const tagged = SET.map((input) => ({
      ...input,
      lines: input.lines.map((line) => ({ ...line, dimensions: { '6': 'P001' } })),
    }))

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', tagged)).resolves.toHaveLength(3)
  })

  it('exempt sources (storno, import, ...) are never checked, exactly as in the engine', async () => {
    vi.mocked(fetchActiveDimensionRules).mockResolvedValue([requiredProjectOn('7510')])
    const exempt = SET.map((input) => ({ ...input, source_type: 'storno' as const }))

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', exempt)).resolves.toHaveLength(3)
    expect(fetchActiveDimensionRules).not.toHaveBeenCalled()
  })

  it('a failed rule fetch fails open like the engine (commitEntry checks again)', async () => {
    vi.mocked(fetchActiveDimensionRules).mockResolvedValue(null)

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', SET)).resolves.toHaveLength(3)
  })

  it('an engine refusal at draft time (archived value) cancels the drafts made so far and posts nothing', async () => {
    const archived = new DimensionValidationError([{ sie_dim_no: '6', code: 'P009', reason: 'archived_value' }])
    vi.mocked(createDraftEntry)
      .mockResolvedValueOnce({ id: 'draft-1', status: 'draft' } as never)
      .mockRejectedValueOnce(archived)

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', SET)).rejects.toBe(archived)
    expect(commitEntry).not.toHaveBeenCalled()
    expect(vi.mocked(cancelDraftEntry).mock.calls.map((call) => call[3])).toEqual(['draft-1'])
  })

  it('a commit failure keeps the committed voucher, cancels the remaining drafts and rethrows', async () => {
    const transient = new Error('connection reset')
    vi.mocked(commitEntry)
      .mockResolvedValueOnce({ id: 'draft-Lön', status: 'posted', voucher_number: 1 } as never)
      .mockRejectedValueOnce(transient)

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', SET)).rejects.toBe(transient)
    expect(vi.mocked(cancelDraftEntry).mock.calls.map((call) => call[3])).toEqual([
      'draft-Lön: Arbetsgivaravgifter',
      'draft-Lön: Semesteravsättning',
    ])
    expect(logged.error).toHaveBeenCalledWith(
      expect.stringContaining('stopped partway'),
      transient,
      expect.objectContaining({ postedEntryIds: ['draft-Lön'] }),
    )
  })

  it('a failing cleanup is logged and never masks the original refusal', async () => {
    const refusal = new Error('refused')
    vi.mocked(createDraftEntry)
      .mockResolvedValueOnce({ id: 'draft-1', status: 'draft' } as never)
      .mockRejectedValueOnce(refusal)
    vi.mocked(cancelDraftEntry).mockRejectedValueOnce(new Error('cancel failed'))

    await expect(createJournalEntries(supabase, 'co-1', 'user-1', SET)).rejects.toBe(refusal)
    expect(logged.error).toHaveBeenCalledWith(
      expect.stringContaining('phantom draft'),
      expect.any(Error),
      expect.objectContaining({ entityId: 'draft-1' }),
    )
  })

  it('a committed voucher whose reload came back empty is still returned by id', async () => {
    vi.mocked(commitEntry).mockResolvedValueOnce(null as never)

    const posted = await createJournalEntries(supabase, 'co-1', 'user-1', SET.slice(0, 1))

    expect(posted).toEqual([expect.objectContaining({ id: 'draft-Lön', status: 'posted' })])
  })
})
