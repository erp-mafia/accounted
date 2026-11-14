/**
 * deadlines.list and deadlines.complete (crm#1848): an agent could only close
 * a moms or AGI deadline, by recording the filing; every other deadline was a
 * tick in the dashboard, and no read listed them. The rule itself is tested
 * in lib/deadlines/__tests__/completion.test.ts; here the contract of the two
 * doors and what they hand an agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { deadlinesComplete, deadlinesList } from '../deadlines'
import type { OperationContext } from '../types'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEADLINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const OPEN_ROW = {
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
}

function setup() {
  const mock = createQueuedMockSupabase()
  const ctx: OperationContext = {
    supabase: mock.supabase as never,
    companyId: COMPANY_ID,
    userId: 'user-1',
    log: createLogger('test'),
  }
  return { ...mock, ctx }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'))
})

describe('deadlines.complete: contract', () => {
  it('is a low-risk bookkeeping:write that stages over MCP as complete_deadline, behind search', () => {
    expect(deadlinesComplete.kind).toBe('write')
    expect(deadlinesComplete.scope).toBe('bookkeeping:write')
    expect(deadlinesComplete.risk).toBe('low')
    expect(deadlinesComplete.http).toBeUndefined()
    expect(deadlinesComplete.mcp?.name).toBe('gnubok_complete_deadline')
    expect(deadlinesComplete.mcp?.visibility ?? 'search').toBe('search')
    expect(deadlinesComplete.mcp?.stage?.pendingType).toBe('complete_deadline')
  })

  it('titles the approval by direction and by the deadline the preview names', () => {
    const title = deadlinesComplete.mcp!.stage!.title
    const preview = { title: 'Skicka underlag till revisorn' }
    expect(title({ deadline_id: DEADLINE_ID, is_completed: true }, preview)).toBe(
      'Bocka av deadline: Skicka underlag till revisorn',
    )
    expect(title({ deadline_id: DEADLINE_ID, is_completed: false }, preview)).toBe(
      'Sätt tillbaka deadline: Skicka underlag till revisorn',
    )
    expect(title({ deadline_id: DEADLINE_ID, is_completed: true })).toBe('Bocka av deadline')
  })

  it('needs a uuid and an explicit boolean state, and no other field (validation, 400)', () => {
    const parse = (value: unknown) => deadlinesComplete.input.safeParse(value).success
    expect(parse({ deadline_id: DEADLINE_ID, is_completed: true })).toBe(true)
    expect(parse({ deadline_id: DEADLINE_ID, is_completed: false })).toBe(true)
    // No toggle on a machine door: a retried toggle would undo its own tick.
    expect(parse({ deadline_id: DEADLINE_ID })).toBe(false)
    expect(parse({ deadline_id: DEADLINE_ID, is_completed: 'false' })).toBe(false)
    expect(parse({ deadline_id: 'deadline-1', is_completed: true })).toBe(false)
    expect(parse({ deadline_id: DEADLINE_ID, is_completed: true, status: 'confirmed' })).toBe(false)
  })
})

describe('deadlines.complete: run', () => {
  const input = { deadline_id: DEADLINE_ID, is_completed: true }

  it('dry run answers what would change and writes nothing', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: OPEN_ROW })

    const outcome = await deadlinesComplete.run(ctx, input, { dryRun: true })

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { deadline_id: DEADLINE_ID, title: OPEN_ROW.title, is_completed: true, effect: 'mark_completed' },
    })
    expect(findCall('deadlines', 'update')).toBeUndefined()
  })

  it('ticks the deadline off and answers it in the output shape, without the stored status', async () => {
    const { ctx, enqueueMany, findCall } = setup()
    enqueueMany([
      { data: OPEN_ROW },
      { data: { ...OPEN_ROW, is_completed: true, completed_at: '2026-11-13T10:00:00.000Z' } },
    ])

    const outcome = await deadlinesComplete.run(ctx, input, { dryRun: false })

    expect(findCall('deadlines', 'update')).toEqual([{ is_completed: true, completed_at: '2026-11-13T10:00:00.000Z' }])
    expect(outcome.ok && !outcome.dryRun).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data.changed).toBe(true)
    expect(outcome.data.deadline).toMatchObject({ deadline_id: DEADLINE_ID, is_completed: true, overdue: false })
    expect(outcome.data.deadline).not.toHaveProperty('status')
    expect(deadlinesComplete.output.safeParse(outcome.data).success).toBe(true)
  })

  it('an already completed deadline is answered unchanged, with no write', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { ...OPEN_ROW, is_completed: true, completed_at: '2026-11-10T09:00:00.000Z' } })

    const outcome = await deadlinesComplete.run(ctx, input, { dryRun: false })

    expect(outcome).toMatchObject({
      ok: true,
      data: { changed: false, deadline: { is_completed: true, completed_at: '2026-11-10T09:00:00.000Z' } },
    })
    expect(findCall('deadlines', 'update')).toBeUndefined()
  })

  it('answers DEADLINE_NOT_FOUND for another company\'s or an unknown deadline', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: null })

    const outcome = await deadlinesComplete.run(ctx, input, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false, code: 'DEADLINE_NOT_FOUND', details: { deadline_id: DEADLINE_ID } })
    expect(findCalls('deadlines', 'eq')).toContainEqual(['company_id', COMPANY_ID])
  })

  it('refuses to put back a deadline Skatteverket confirmed', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { ...OPEN_ROW, is_completed: true, completed_at: '2026-11-10T09:00:00.000Z', status: 'confirmed' } })

    const outcome = await deadlinesComplete.run(ctx, { deadline_id: DEADLINE_ID, is_completed: false }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false, code: 'DEADLINE_CONFIRMED_BY_SKATTEVERKET' })
    expect(findCall('deadlines', 'update')).toBeUndefined()
  })
})

describe('deadlines.list', () => {
  it('is a reports:read tool behind search that lists open deadlines by default', () => {
    expect(deadlinesList.kind).toBe('read')
    expect(deadlinesList.scope).toBe('reports:read')
    expect(deadlinesList.mcp?.name).toBe('gnubok_list_deadlines')
    expect(deadlinesList.mcp?.visibility ?? 'search').toBe('search')
    expect(deadlinesList.mcp?.stage).toBeUndefined()
    expect(deadlinesList.input.parse({})).toEqual({ status: 'open', limit: 100 })
  })

  it('refuses an unknown status, a malformed date, a limit out of range and unknown fields', () => {
    const parse = (value: unknown) => deadlinesList.input.safeParse(value).success
    expect(parse({ status: 'overdue' })).toBe(false)
    expect(parse({ due_from: '2026-02-30' })).toBe(false)
    expect(parse({ limit: 0 })).toBe(false)
    expect(parse({ limit: 501 })).toBe(false)
    expect(parse({ company: 'x' })).toBe(false)
  })

  it('answers the open deadlines in the output shape', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: [{ ...OPEN_ROW, due_date: '2026-11-12', status: 'overdue' }] })

    const outcome = await deadlinesList.run(ctx, deadlinesList.input.parse({}), { dryRun: false })

    expect(findCalls('deadlines', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['is_completed', false],
    ])
    expect(outcome.ok && !outcome.dryRun).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data).toMatchObject({ has_more: false, deadlines: [{ deadline_id: DEADLINE_ID, overdue: true }] })
    expect(deadlinesList.output.safeParse(outcome.data).success).toBe(true)
  })
})
