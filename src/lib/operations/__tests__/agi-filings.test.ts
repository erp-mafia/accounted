/**
 * agi-filings.mark (agent feedback seq 892914): an AGI filed outside
 * Accounted could not be recorded over MCP, so the month's AGI deadline kept
 * asking for it. The operation completes that deadline and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { agiFilingsMark } from '../agi-filings'
import type { OperationContext } from '../types'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEADLINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const PENDING_DEADLINE = {
  id: DEADLINE_ID,
  tax_period: '2026-08',
  due_date: '2026-09-12',
  is_completed: false,
  completed_at: null,
  status: 'upcoming',
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

const input = { year: 2026, month: 8, filed_on: '2026-09-10' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'))
})

describe('agi-filings.mark: contract', () => {
  it('is a low-risk payroll:write that stages over MCP as mark_agi_period_filed', () => {
    expect(agiFilingsMark.kind).toBe('write')
    expect(agiFilingsMark.scope).toBe('payroll:write')
    expect(agiFilingsMark.risk).toBe('low')
    expect(agiFilingsMark.mcp?.name).toBe('gnubok_mark_agi_period_filed')
    expect(agiFilingsMark.mcp?.stage?.pendingType).toBe('mark_agi_period_filed')
    expect(agiFilingsMark.mcp?.stage?.title(input)).toBe('Markera arbetsgivardeklaration 2026-08 som inlämnad')
  })

  it('refuses a month outside 1-12 and a malformed date (validation, 400)', () => {
    expect(agiFilingsMark.input.safeParse({ ...input, month: 13 }).success).toBe(false)
    expect(agiFilingsMark.input.safeParse({ ...input, filed_on: '2026-02-30' }).success).toBe(false)
  })
})

describe('agi-filings.mark: run', () => {
  it('refuses a filing date in the future before any read', async () => {
    const { ctx, supabase } = setup()

    const outcome = await agiFilingsMark.run(ctx, { ...input, filed_on: '2026-10-07' }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'AGI_FILING_DATE_IN_FUTURE' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers AGI_DEADLINE_NOT_FOUND when the company has no AGI deadline for the month (404)', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: [] })

    const outcome = await agiFilingsMark.run(ctx, input, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'AGI_DEADLINE_NOT_FOUND', details: { tax_period: '2026-08' } })
  })

  it('looks the deadline up by type and redovisningsperiod in this company', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: [PENDING_DEADLINE] })

    await agiFilingsMark.run(ctx, input, { dryRun: true })

    expect(findCalls('deadlines', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', COMPANY_ID],
        ['tax_deadline_type', 'arbetsgivardeklaration'],
        ['tax_period', '2026-08'],
      ]),
    )
  })

  it('previews the mark on a dry run and writes nothing', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: [PENDING_DEADLINE] })

    const outcome = await agiFilingsMark.run(ctx, input, { dryRun: true })

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { deadline_id: DEADLINE_ID, tax_period: '2026-08', filed_on: '2026-09-10', effect: 'mark_submitted' },
    })
    expect(findCalls('deadlines', 'update')).toEqual([])
  })

  it('completes the deadline as submitted on the filing date', async () => {
    const { ctx, enqueueMany, findCalls } = setup()
    enqueueMany([{ data: [PENDING_DEADLINE] }, { data: { id: DEADLINE_ID } }])

    const outcome = await agiFilingsMark.run(ctx, input, { dryRun: false })

    expect(outcome).toMatchObject({
      ok: true,
      data: { deadline_id: DEADLINE_ID, tax_period: '2026-08', filed_on: '2026-09-10', status: 'submitted', changed: true },
    })
    const [payload] = findCalls('deadlines', 'update')[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ is_completed: true, completed_at: '2026-09-10T12:00:00.000Z', status: 'submitted' })
    // A kvittens that confirmed the period in between is never relabelled.
    expect(findCalls('deadlines', 'or')).toContainEqual(['status.is.null,status.neq.confirmed'])
  })

  it('leaves a deadline Skatteverket confirmed unchanged', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: [{ ...PENDING_DEADLINE, is_completed: true, status: 'confirmed' }] })

    const outcome = await agiFilingsMark.run(ctx, input, { dryRun: false })

    expect(outcome).toMatchObject({ ok: true, data: { status: 'confirmed', changed: false } })
    expect(findCalls('deadlines', 'update')).toEqual([])
  })
})
