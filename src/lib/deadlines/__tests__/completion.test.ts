/**
 * lib/deadlines/completion.ts (crm#1848): the one rule for ticking a deadline
 * off or putting it back, and the list an agent picks the deadline from. The
 * dashboard route and the operations deadlines.complete / deadlines.list all
 * run these functions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listDeadlines, setDeadlineCompletion, summarizeDeadline } from '../completion'
import type { Deadline } from '@/types'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEADLINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function deadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: DEADLINE_ID,
    company_id: COMPANY_ID,
    title: 'Skicka underlag till revisorn',
    due_date: '2026-11-20',
    due_time: null,
    deadline_type: 'other',
    priority: 'normal',
    is_completed: false,
    completed_at: null,
    notes: null,
    tax_deadline_type: null,
    tax_period: null,
    source: 'user',
    status: 'upcoming',
    dismissed_at: null,
    ...overrides,
  } as Deadline
}

function setup() {
  const mock = createQueuedMockSupabase()
  return { ...mock, ctx: { supabase: mock.supabase as never, companyId: COMPANY_ID } }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'))
})

describe('setDeadlineCompletion', () => {
  it('ticks an open deadline off and stamps completed_at', async () => {
    const { ctx, enqueueMany, findCall, findCalls } = setup()
    enqueueMany([
      { data: deadline() },
      { data: deadline({ is_completed: true, completed_at: '2026-11-13T10:00:00.000Z' }) },
    ])

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: true, data: { changed: true, deadline: { is_completed: true } } })
    expect(findCall('deadlines', 'update')).toEqual([
      { is_completed: true, completed_at: '2026-11-13T10:00:00.000Z' },
    ])
    // Both the read and the write are scoped to the company.
    expect(findCalls('deadlines', 'eq').filter((args) => args[0] === 'company_id')).toEqual([
      ['company_id', COMPANY_ID],
      ['company_id', COMPANY_ID],
    ])
  })

  it('puts a completed deadline back and clears completed_at', async () => {
    const { ctx, enqueueMany, findCall } = setup()
    enqueueMany([
      { data: deadline({ is_completed: true, completed_at: '2026-11-10T09:00:00.000Z' }) },
      { data: deadline() },
    ])

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: false }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: true, data: { changed: true, deadline: { is_completed: false } } })
    expect(findCall('deadlines', 'update')).toEqual([{ is_completed: false, completed_at: null }])
  })

  it('writes nothing when the deadline is already completed, and keeps its completed_at', async () => {
    const { ctx, enqueue, findCall } = setup()
    const done = deadline({ is_completed: true, completed_at: '2026-11-10T09:00:00.000Z' })
    enqueue({ data: done })

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: false })

    expect(outcome).toEqual({ ok: true, data: { deadline: done, changed: false } })
    expect(findCall('deadlines', 'update')).toBeUndefined()
  })

  it('flips the state when none is named (the dashboard body-less call)', async () => {
    const { ctx, enqueueMany, findCall } = setup()
    enqueueMany([{ data: deadline() }, { data: deadline({ is_completed: true }) }])

    await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID }, { dryRun: false })

    expect(findCall('deadlines', 'update')).toMatchObject([{ is_completed: true }])
  })

  it('answers DEADLINE_NOT_FOUND when the company has no such deadline (wrong company, dismissed)', async () => {
    const { ctx, enqueue, findCall, findCalls } = setup()
    enqueue({ data: null })

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: false })

    expect(outcome).toEqual({ ok: false, code: 'DEADLINE_NOT_FOUND', details: { deadline_id: DEADLINE_ID } })
    // The read is what keeps another company's and a dismissed deadline out.
    expect(findCalls('deadlines', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    expect(findCalls('deadlines', 'is')).toEqual([['dismissed_at', null]])
    expect(findCall('deadlines', 'update')).toBeUndefined()
  })

  it('answers DEADLINE_NOT_FOUND for an id that is not a uuid, before any read', async () => {
    const { ctx, calls } = setup()

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: 'deadline-1', isCompleted: true }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false, code: 'DEADLINE_NOT_FOUND' })
    expect(calls).toEqual([])
  })

  it('answers DEADLINE_NOT_FOUND when the row went away between the read and the write', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([{ data: deadline() }, { data: null }])

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false, code: 'DEADLINE_NOT_FOUND' })
  })

  it('hands a database failure on as UNKNOWN_ERROR', async () => {
    const { ctx, enqueue } = setup()
    const error = { code: '57014', message: 'canceling statement due to statement timeout' }
    enqueue({ error })

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: false })

    expect(outcome).toEqual({ ok: false, code: 'UNKNOWN_ERROR', error })
  })

  it('previews without writing', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: deadline() })

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: true })

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        deadline_id: DEADLINE_ID,
        title: 'Skicka underlag till revisorn',
        due_date: '2026-11-20',
        tax_deadline_type: null,
        tax_period: null,
        current: { is_completed: false, completed_at: null },
        is_completed: true,
        effect: 'mark_completed',
      },
    })
    expect(findCall('deadlines', 'update')).toBeUndefined()
  })

  it('previews an already completed deadline as unchanged', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: deadline({ is_completed: true, completed_at: '2026-11-10T09:00:00.000Z' }) })

    const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: true }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { effect: 'unchanged' } })
  })

  describe('a deadline Skatteverket confirmed through the connection', () => {
    const confirmed = deadline({
      is_completed: true,
      completed_at: '2026-11-10T09:00:00.000Z',
      status: 'confirmed',
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2026-Q3',
      source: 'system',
    })

    it('is never put back through a machine door, on the dry run too', async () => {
      for (const dryRun of [true, false]) {
        const { ctx, enqueue, findCall } = setup()
        enqueue({ data: confirmed })

        const outcome = await setDeadlineCompletion(
          ctx,
          { deadlineId: DEADLINE_ID, isCompleted: false },
          { dryRun, protectConfirmed: true },
        )

        expect(outcome).toEqual({
          ok: false,
          code: 'DEADLINE_CONFIRMED_BY_SKATTEVERKET',
          details: { deadline_id: DEADLINE_ID },
        })
        expect(findCall('deadlines', 'update')).toBeUndefined()
      }
    })

    it('can still be put back by a person in the dashboard', async () => {
      const { ctx, enqueueMany, findCall } = setup()
      enqueueMany([{ data: confirmed }, { data: { ...confirmed, is_completed: false, completed_at: null } }])

      const outcome = await setDeadlineCompletion(ctx, { deadlineId: DEADLINE_ID, isCompleted: false }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: true, data: { changed: true } })
      expect(findCall('deadlines', 'update')).toEqual([{ is_completed: false, completed_at: null }])
    })

    it('asking a machine door to complete it again is a no-op, not a refusal', async () => {
      const { ctx, enqueue } = setup()
      enqueue({ data: confirmed })

      const outcome = await setDeadlineCompletion(
        ctx,
        { deadlineId: DEADLINE_ID, isCompleted: true },
        { dryRun: false, protectConfirmed: true },
      )

      expect(outcome).toMatchObject({ ok: true, data: { changed: false } })
    })
  })
})

describe('summarizeDeadline', () => {
  it('calls an open deadline past its date overdue, and the due date itself on time', () => {
    expect(summarizeDeadline(deadline({ due_date: '2026-11-12' }), '2026-11-13')).toMatchObject({
      overdue: true,
      days_until_due: -1,
    })
    expect(summarizeDeadline(deadline({ due_date: '2026-11-13' }), '2026-11-13')).toMatchObject({
      overdue: false,
      days_until_due: 0,
    })
  })

  it('never calls a completed deadline overdue, whatever the stored status says', () => {
    const summary = summarizeDeadline(
      deadline({ due_date: '2026-10-01', is_completed: true, completed_at: '2026-10-05T08:00:00.000Z', status: 'overdue' }),
      '2026-11-13',
    )
    expect(summary.overdue).toBe(false)
    expect(summary.is_completed).toBe(true)
    // The stale stored status is not handed out next to is_completed.
    expect(summary).not.toHaveProperty('status')
    expect(summary).not.toHaveProperty('id')
  })
})

describe('listDeadlines', () => {
  const input = { status: 'open' as const, limit: 100 }

  it('lists the open deadlines of the company by due date: not completed, not dismissed', async () => {
    const { ctx, enqueue, findCalls, findCall } = setup()
    enqueue({ data: [deadline({ due_date: '2026-11-12' })] })

    const outcome = await listDeadlines(ctx, input)

    expect(outcome).toMatchObject({
      ok: true,
      data: { has_more: false, deadlines: [{ deadline_id: DEADLINE_ID, overdue: true, days_until_due: -1 }] },
    })
    expect(findCalls('deadlines', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['is_completed', false],
    ])
    expect(findCalls('deadlines', 'is')).toEqual([['dismissed_at', null]])
    expect(findCall('deadlines', 'order')).toEqual(['due_date', { ascending: true }])
    expect(findCall('deadlines', 'limit')).toEqual([101])
  })

  it('lists completed ones on request, still without the dismissed', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: [] })

    await listDeadlines(ctx, { ...input, status: 'completed' })

    expect(findCalls('deadlines', 'eq')).toContainEqual(['is_completed', true])
    expect(findCalls('deadlines', 'is')).toEqual([['dismissed_at', null]])
  })

  it('lists all without a completion filter, still without the dismissed', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: [] })

    await listDeadlines(ctx, { ...input, status: 'all' })

    expect(findCalls('deadlines', 'eq')).toEqual([['company_id', COMPANY_ID]])
    expect(findCalls('deadlines', 'is')).toEqual([['dismissed_at', null]])
  })

  it('narrows by due date and says when more match than the limit', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({
      data: [
        deadline({ id: '11111111-1111-4111-8111-111111111111' }),
        deadline({ id: '22222222-2222-4222-8222-222222222222' }),
        deadline({ id: '33333333-3333-4333-8333-333333333333' }),
      ],
    })

    const outcome = await listDeadlines(ctx, { status: 'open', due_from: '2026-11-01', due_to: '2026-11-30', limit: 2 })

    expect(findCall('deadlines', 'gte')).toEqual(['due_date', '2026-11-01'])
    expect(findCall('deadlines', 'lte')).toEqual(['due_date', '2026-11-30'])
    expect(outcome).toMatchObject({ ok: true, data: { has_more: true } })
    expect(outcome.ok && !outcome.dryRun ? outcome.data.deadlines : []).toHaveLength(2)
  })

  it('hands a database failure on as UNKNOWN_ERROR', async () => {
    const { ctx, enqueue } = setup()
    const error = { code: '57014', message: 'timeout' }
    enqueue({ error })

    expect(await listDeadlines(ctx, input)).toEqual({ ok: false, code: 'UNKNOWN_ERROR', error })
  })
})
