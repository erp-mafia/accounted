import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '../types'
import { timeEntriesCodes, timeEntriesList, timeEntriesSummary } from '../time-entries'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '22222222-2222-4222-8222-222222222222'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  company_id: 'company-1',
  user_id: 'user-1',
  entry_date: '2026-10-14',
  consultant: 'AB',
  customer_id: CUSTOMER_ID,
  customer_code: 'GF',
  customer_name: 'Galärbryggan (import)',
  project_code: 'P12',
  activity_code: '1',
  hours: '3.50',
  comment: null,
  is_billable: true,
  invoice_id: null,
  source: 'manual',
  import_key: null,
  created_at: '2026-10-14T15:02:11Z',
  updated_at: '2026-10-14T15:02:11Z',
  customers: { name: 'Galärbryggan AB' },
  ...overrides,
})

const settings = {
  consultants: [{ code: 'AB', name: 'Anna Berg' }],
  activity_codes: [{ code: '1', name: 'Löpande', hourly_rate: 950 }],
  customer_links: [{ code: 'GF', customer_id: CUSTOMER_ID }],
  default_hourly_rate: 800,
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  mock = createQueuedMockSupabase()
  ctx = {
    supabase: mock.supabase as unknown as OperationContext['supabase'],
    companyId: 'company-1',
    userId: 'user-1',
    log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child: () => ctx.log } as unknown as OperationContext['log'],
  }
})

describe('time-entries.list', () => {
  it('parses query-string input the way the v1 door passes it', () => {
    const parsed = timeEntriesList.input.parse({ limit: '25', offset: '50', uninvoiced: 'true', from: '2026-10-01' })
    expect(parsed).toMatchObject({ limit: 25, offset: 50, uninvoiced: 'true', from: '2026-10-01' })
    expect(() => timeEntriesList.input.parse({ limit: '501' })).toThrow()
    expect(() => timeEntriesList.input.parse({ from: '2026-13-01' })).toThrow()
  })

  it('answers qualified ids, the linked customer name and numeric hours, without internal columns', async () => {
    mock.enqueue({ data: [row()], count: 1 })
    const outcome = await timeEntriesList.run(ctx, timeEntriesList.input.parse({}), { dryRun: false })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data).toEqual({
      entries: [
        expect.objectContaining({ time_entry_id: ENTRY_ID, customer_name: 'Galärbryggan AB', hours: 3.5 }),
      ],
      total: 1,
      has_more: false,
      next_offset: null,
    })
    const entry = outcome.data.entries[0] as Record<string, unknown>
    for (const internal of ['id', 'company_id', 'user_id', 'import_key', 'customers']) {
      expect(entry).not.toHaveProperty(internal)
    }
    expect(timeEntriesList.output.safeParse(outcome.data).success).toBe(true)
  })

  it('scopes to the company, applies the filters and pages by offset', async () => {
    mock.enqueue({ data: [row()], count: 120 })
    const input = timeEntriesList.input.parse({
      consultant: 'ab',
      customer_code: 'gf',
      project_code: 'P12',
      uninvoiced: 'true',
      limit: '10',
      offset: '20',
    })
    const outcome = await timeEntriesList.run(ctx, input, { dryRun: false })
    expect(mock.findCalls('time_entries', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['consultant', 'AB'],
        ['customer_code', 'GF'],
        ['project_code', 'P12'],
        ['is_billable', true],
      ]),
    )
    expect(mock.findCall('time_entries', 'is')).toEqual(['invoice_id', null])
    expect(mock.findCall('time_entries', 'range')).toEqual([20, 29])
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data).toMatchObject({ total: 120, has_more: true, next_offset: 30 })
  })

  it('answers a structured failure when the query fails', async () => {
    mock.enqueue({ error: { message: 'boom' } })
    const outcome = await timeEntriesList.run(ctx, timeEntriesList.input.parse({}), { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
  })
})

describe('time-entries.summary', () => {
  it('defaults to grouping by customer and validates group_by', () => {
    expect(timeEntriesSummary.input.parse({}).group_by).toBe('customer')
    expect(() => timeEntriesSummary.input.parse({ group_by: 'activity' })).toThrow()
  })

  it('totals per consultant and month and prices uninvoiced billable hours', async () => {
    mock.enqueue({
      data: [
        row({ hours: '2' }),
        row({ id: 'b', hours: '1.5', activity_code: null }),
        row({ id: 'c', hours: '4', consultant: 'CD', is_billable: false }),
      ],
    })
    mock.enqueue({ data: { value: settings } })
    const outcome = await timeEntriesSummary.run(
      ctx,
      timeEntriesSummary.input.parse({ group_by: 'consultant' }),
      { dryRun: false },
    )
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data.rows).toEqual([
      expect.objectContaining({ key: 'AB', label: 'AB', month: '2026-10', hours: 3.5, uninvoiced_amount: 2 * 950 + 1.5 * 800 }),
      expect.objectContaining({ key: 'CD', hours: 4, billable_hours: 0, uninvoiced_amount: 0 }),
    ])
    expect(outcome.data.totals).toEqual({
      hours: 7.5,
      billable_hours: 3.5,
      uninvoiced_billable_hours: 3.5,
      uninvoiced_amount: 3100,
    })
    expect(timeEntriesSummary.output.safeParse(outcome.data).success).toBe(true)
  })

  it('leaves the total amount unknown when some hours have no rate', async () => {
    mock.enqueue({ data: [row({ hours: '2' })] })
    mock.enqueue({ data: { value: { ...settings, activity_codes: [], default_hourly_rate: null } } })
    const outcome = await timeEntriesSummary.run(ctx, timeEntriesSummary.input.parse({}), { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data.totals.uninvoiced_amount).toBeNull()
  })
})

describe('time-entries.codes', () => {
  it('lists registers, linked customer codes with current names and active projects', async () => {
    mock.enqueue({ data: { value: { ...settings, customer_links: [...settings.customer_links, { code: 'OLD', customer_id: '99999999-9999-4999-8999-999999999999' }] } } })
    mock.enqueue({ data: [{ id: CUSTOMER_ID, name: 'Galärbryggan AB' }] })
    mock.enqueue({ data: [{ code: 'P12', name: 'Bokslut 2026', dimensions: { sie_dim_no: 6 } }] })
    const outcome = await timeEntriesCodes.run(ctx, {}, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data).toEqual({
      consultants: settings.consultants,
      activity_codes: settings.activity_codes,
      default_hourly_rate: 800,
      // The link to a customer that no longer exists is not offered.
      customer_codes: [{ code: 'GF', customer_id: CUSTOMER_ID, customer_name: 'Galärbryggan AB' }],
      projects: [{ code: 'P12', name: 'Bokslut 2026' }],
    })
    expect(timeEntriesCodes.output.safeParse(outcome.data).success).toBe(true)
  })

  it('answers empty registers for a company that never set up time tracking', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [] })
    const outcome = await timeEntriesCodes.run(ctx, {}, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data).toMatchObject({ consultants: [], customer_codes: [], projects: [], default_hourly_rate: null })
  })
})
