/**
 * commitAccrualInstallment() and commitAccrualDissolution(): the engine doors
 * that post a periodisering month's verifikat and mark the month posted
 * (commit_accrual_installment, migration 20261113020117), or post the one
 * verifikat for the rest of a schedule and mark every pending month
 * (commit_accrual_dissolution, migration 20261112181809), each in one
 * database transaction.
 *
 * What the database guarantees (one posted verifikat per month whoever
 * races, nothing written for a month already taken) is pinned against real
 * Postgres in tests/pg/accrual-installment-commit.pg.test.ts. These tests pin
 * the engine's side: what it sends, that a draft is never stranded, that a
 * month already taken is an answer and not an error, and that only a
 * database without the function yet (PGRST202) makes the door post the draft
 * the old way through its own commit, reported as an error once per process.
 *
 * Also pinned here: the generic commit (commitEntry, behind the dashboard,
 * the v1 API, MCP and the posting port) and createJournalEntry refuse a
 * periodisering draft, which only these doors post.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const emit = vi.fn().mockResolvedValue([])
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
}))

// log.error is what reaches the error tracker: the fallback must be reported.
const mockLogError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLogError, child: vi.fn() }
  logger.child.mockReturnValue(logger)
  return { ...(await importOriginal<typeof import('@/lib/logger')>()), createLogger: () => logger }
})

const { commitAccrualInstallment, commitAccrualDissolution, commitEntry, createJournalEntry } = await import('../engine')
const { AccrualDraftPostedByScheduleError, BookkeepingDatabaseError } = await import('../errors')
// Imported with the errors module above: a test below resets the module
// registry, and the mapping must see the same error classes.
const { errorResponse } = await import('@/lib/errors/get-structured-error')
const { getErrorMessage } = await import('@/lib/errors/get-error-message')
const { runWithActor } = await import('../actor-context-node')

const COMPANY = 'company-1'
const USER = 'user-1'
const DRAFT = { id: 'draft-1' }
const INSTALLMENT = 'inst-1'
const POSTED = { id: 'draft-1', company_id: COMPANY, status: 'posted', voucher_number: 12, lines: [] }

/** The CAS cancel of a draft: status cancelled, only while it is still a draft. */
function draftCancels(mock: ReturnType<typeof createTableMockSupabase>): unknown[] {
  return mock.payloads('journal_entries', 'update')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitAccrualInstallment', () => {
  it('sends the month and its draft to the one function, then announces the posted verifikat', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_installment': { data: [{ outcome: 'posted', voucher_number: 12 }] },
      journal_entries: { data: POSTED },
    })

    const result = await runWithActor({ type: 'user', label: 'Anna' }, () =>
      commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT),
    )

    expect(result).toEqual({ outcome: 'posted', entry: POSTED })
    expect(mock.findCall('rpc:commit_accrual_installment', 'rpc')).toEqual([
      {
        p_company_id: COMPANY,
        p_installment_id: INSTALLMENT,
        p_entry_id: 'draft-1',
        // WHO and HOW are stamped as commitEntry stamps them.
        p_commit_method: 'user_accept',
        p_actor_type: 'user',
        p_actor_label: 'Anna',
      },
    ])
    // No second write to the month and no cancel: the function did both halves.
    expect(mock.tables()).not.toContain('accrual_schedule_installments')
    expect(draftCancels(mock)).toEqual([])
    expect(emit).toHaveBeenCalledWith({
      type: 'journal_entry.committed',
      payload: { entry: POSTED, userId: USER, companyId: COMPANY },
    })
  })

  it('a month another run took first: the draft is cancelled, nothing is posted or announced', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_installment': { data: [{ outcome: 'not_pending', voucher_number: null }] },
    })

    const result = await commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT)

    expect(result).toEqual({ outcome: 'not_pending' })
    expect(draftCancels(mock)).toEqual([{ status: 'cancelled' }])
    expect(mock.findCalls('journal_entries', 'eq')).toEqual([
      ['id', 'draft-1'],
      ['status', 'draft'],
    ])
    expect(emit).not.toHaveBeenCalled()
  })

  it('a database without the function yet (PGRST202): the door posts the draft through its own commit, reported once per process', async () => {
    // A fresh module: the report is once per process, and an earlier test in
    // this file could already have made it.
    vi.resetModules()
    const fresh = await import('../engine')

    for (let run = 0; run < 2; run++) {
      const mock = createTableMockSupabase({
        'rpc:commit_accrual_installment': {
          error: { code: 'PGRST202', message: 'Could not find the function public.commit_accrual_installment' },
        },
        journal_entries: { data: POSTED },
      })
      const result = await fresh.commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT)
      // Posted the way it was before the function; the caller claims the month.
      expect(result).toEqual({ outcome: 'posted_unclaimed', entry: POSTED })
      expect(mock.findCall('rpc:commit_journal_entry', 'rpc')).toEqual([expect.objectContaining({ p_entry_id: 'draft-1' })])
      // Not the generic commit: its periodisering refusal is never asked.
      expect(mock.findCalls('journal_entries', 'select')).not.toContainEqual(['source_type'])
      expect(mock.tables()).not.toContain('accrual_schedule_installments')
    }

    const fallbackReports = mockLogError.mock.calls.filter(([message]) =>
      String(message).includes('commit_accrual_installment is not in the database'),
    )
    expect(fallbackReports).toHaveLength(1)
    expect(fallbackReports[0]![2]).toEqual(expect.objectContaining({ pgCode: 'PGRST202' }))
  })

  it('a fallback commit that fails leaves the draft cancelled, with no number', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_installment': { error: { code: 'PGRST202', message: 'function not found' } },
      'rpc:commit_journal_entry': { error: { code: 'P0001', message: 'Cannot write to locked/closed fiscal period' } },
    })

    await expect(
      commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)

    expect(draftCancels(mock)).toEqual([{ status: 'cancelled' }])
    expect(emit).not.toHaveBeenCalled()
  })

  it('42883 is a failure inside the function, not a missing deploy: the draft is cancelled and it throws', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_installment': {
        error: { code: '42883', message: 'operator does not exist: uuid = text' },
      },
    })

    await expect(
      commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)

    expect(draftCancels(mock)).toEqual([{ status: 'cancelled' }])
    expect(mockLogError).toHaveBeenCalledWith('commit_accrual_installment RPC failed', expect.anything(), expect.objectContaining({ pgCode: '42883' }))
    expect(emit).not.toHaveBeenCalled()
  })

  it('a refused commit cancels the draft and throws: nothing was numbered', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_installment': {
        error: { code: 'P0001', message: 'Cannot write to a locked period' },
      },
    })

    await expect(
      commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)

    expect(draftCancels(mock)).toEqual([{ status: 'cancelled' }])
    expect(emit).not.toHaveBeenCalled()
  })

  it('an answer without an outcome is an error, never read as posted', async () => {
    const mock = createTableMockSupabase({ 'rpc:commit_accrual_installment': { data: [] } })

    await expect(
      commitAccrualInstallment(mock.supabase as never, COMPANY, USER, DRAFT, INSTALLMENT),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('commitAccrualDissolution', () => {
  const LINK = { scheduleId: 'sched-1', installmentIds: ['inst-11', 'inst-12'] }

  it('sends the schedule, the months its amount was added up from and the draft to the one function', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_dissolution': { data: [{ outcome: 'posted', voucher_number: 13 }] },
      journal_entries: { data: POSTED },
    })

    const result = await runWithActor({ type: 'user', label: 'Anna' }, () =>
      commitAccrualDissolution(mock.supabase as never, COMPANY, USER, DRAFT, LINK),
    )

    expect(result).toEqual({ outcome: 'posted', entry: POSTED })
    expect(mock.findCall('rpc:commit_accrual_dissolution', 'rpc')).toEqual([
      {
        p_company_id: COMPANY,
        p_schedule_id: 'sched-1',
        p_installment_ids: ['inst-11', 'inst-12'],
        p_entry_id: 'draft-1',
        p_commit_method: 'user_accept',
        p_actor_type: 'user',
        p_actor_label: 'Anna',
      },
    ])
    // The months and the schedule are the function's to write.
    expect(mock.tables()).not.toContain('accrual_schedule_installments')
    expect(mock.tables()).not.toContain('accrual_schedules')
    expect(draftCancels(mock)).toEqual([])
    expect(emit).toHaveBeenCalledWith({
      type: 'journal_entry.committed',
      payload: { entry: POSTED, userId: USER, companyId: COMPANY },
    })
  })

  it('the pending months changed underneath: the draft is cancelled, nothing is posted or announced', async () => {
    const mock = createTableMockSupabase({
      'rpc:commit_accrual_dissolution': { data: [{ outcome: 'not_pending', voucher_number: null }] },
    })

    const result = await commitAccrualDissolution(mock.supabase as never, COMPANY, USER, DRAFT, LINK)

    expect(result).toEqual({ outcome: 'not_pending' })
    expect(draftCancels(mock)).toEqual([{ status: 'cancelled' }])
    expect(emit).not.toHaveBeenCalled()
  })

  it('only PGRST202 posts the draft the old way; any other refusal cancels it and throws', async () => {
    const missing = createTableMockSupabase({
      'rpc:commit_accrual_dissolution': { error: { code: 'PGRST202', message: 'function not found' } },
      journal_entries: { data: POSTED },
    })
    expect(await commitAccrualDissolution(missing.supabase as never, COMPANY, USER, DRAFT, LINK)).toEqual({
      outcome: 'posted_unclaimed',
      entry: POSTED,
    })
    // The months are the caller's to claim; the door wrote none of them.
    expect(missing.tables()).not.toContain('accrual_schedule_installments')

    const refused = createTableMockSupabase({
      'rpc:commit_accrual_dissolution': { error: { code: '23514', message: 'The pending months add up to 8000, the draft voucher to 4000' } },
    })
    await expect(
      commitAccrualDissolution(refused.supabase as never, COMPANY, USER, DRAFT, LINK),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(draftCancels(refused)).toEqual([{ status: 'cancelled' }])
  })
})

describe('the generic commit refuses a periodisering draft', () => {
  it('commitEntry: a draft with source_type accrual is refused before anything is posted', async () => {
    const mock = createTableMockSupabase({ journal_entries: { data: { source_type: 'accrual' } } })

    const failure = await commitEntry(mock.supabase as never, COMPANY, USER, 'draft-1').catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(AccrualDraftPostedByScheduleError)
    expect((failure as InstanceType<typeof AccrualDraftPostedByScheduleError>).journalEntryId).toBe('draft-1')
    // No voucher number drawn, nothing written, the draft left for its schedule.
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
    expect(mock.findCalls('journal_entries', 'update')).toEqual([])
    expect(mock.findCalls('journal_entries', 'eq')).toEqual([
      ['id', 'draft-1'],
      ['company_id', COMPANY],
    ])
    expect(emit).not.toHaveBeenCalled()
  })

  it('commitEntry: any other draft is committed as before', async () => {
    const mock = createTableMockSupabase({
      journal_entries: [{ data: { source_type: 'manual' } }, { data: POSTED }],
    })

    const entry = await commitEntry(mock.supabase as never, COMPANY, USER, 'draft-1')

    expect(entry).toEqual(POSTED)
    expect(mock.findCall('rpc:commit_journal_entry', 'rpc')).toEqual([expect.objectContaining({ p_entry_id: 'draft-1' })])
  })

  it('createJournalEntry: a periodisering input is refused before a draft is written', async () => {
    const mock = createTableMockSupabase()

    await expect(
      createJournalEntry(mock.supabase as never, COMPANY, USER, {
        fiscal_period_id: 'fp-1',
        entry_date: '2026-03-01',
        description: 'Periodisering 2026-03',
        source_type: 'accrual',
        source_id: 'sched-1',
        lines: [
          { account_number: '6310', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1730', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
    ).rejects.toBeInstanceOf(AccrualDraftPostedByScheduleError)

    expect(mock.tables()).toEqual([])
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('the refusal answers 409 with the Swedish sentence', async () => {
    const response = errorResponse(new AccrualDraftPostedByScheduleError('draft-1'), { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never)
    const body = (await response.json()) as { error: { code: string; message: string; details?: unknown } }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('ACCRUAL_DRAFT_POSTED_BY_SCHEDULE')
    expect(body.error.message).toMatch(/^Periodiseringens verifikat bokförs av periodiseringen själv/)
    expect(body.error.details).toEqual({ journal_entry_id: 'draft-1' })
    // The same sentence wherever the error is shown, never the English class message.
    expect(getErrorMessage(new AccrualDraftPostedByScheduleError('draft-1'))).toBe(body.error.message)
  })
})
