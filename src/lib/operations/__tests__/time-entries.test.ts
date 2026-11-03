import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '../types'
import {
  timeEntriesCodes,
  timeEntriesCreate,
  timeEntriesDelete,
  timeEntriesList,
  timeEntriesSummary,
  timeEntriesUpdate,
} from '../time-entries'

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

// ── Writes ──────────────────────────────────────────────────────────────────

const OTHER_CUSTOMER = '33333333-3333-4333-8333-333333333333'
const registers = {
  ...settings,
  consultants: [{ code: 'AB', name: 'Anna Berg', user_id: 'user-1' }, { code: 'CD', name: 'Carl Dahl' }],
  activity_codes: [
    { code: '1', name: 'Löpande bokföring', hourly_rate: 950 },
    { code: '2', name: 'Bokslut', hourly_rate: 1200 },
  ],
}
const customerRows = [
  { id: CUSTOMER_ID, name: 'Galärbryggan AB', customer_number: '1001' },
  { id: OTHER_CUSTOMER, name: 'Rederi Nordstjernan AB', customer_number: null },
]
const projectRows = [{ code: 'P12', name: 'Bokslut 2026' }]

const createStage = timeEntriesCreate.mcp!.stage!
const updateStage = timeEntriesUpdate.mcp!.stage!

describe('time-entries.create', () => {
  it('needs exactly one of customer_id and customer, and at most 20 entries', () => {
    const entry = { entry_date: '2026-11-02', hours: 1 }
    expect(() => timeEntriesCreate.input.parse({ entries: [entry] })).toThrow()
    expect(() => timeEntriesCreate.input.parse({ entries: [{ ...entry, customer: 'x', customer_id: CUSTOMER_ID }] })).toThrow()
    expect(() => timeEntriesCreate.input.parse({ entries: [{ ...entry, customer: 'x', hours: 1.255 }] })).toThrow()
    expect(() => timeEntriesCreate.input.parse({ entries: Array(21).fill({ ...entry, customer: 'x' }) })).toThrow()
    expect(timeEntriesCreate.input.parse({ entries: [{ ...entry, customer: 'x' }] }).entries).toHaveLength(1)
  })

  it('resolves names, defaults to the caller\'s consultant and previews what will be registered', async () => {
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: customerRows })
    mock.enqueue({ data: projectRows })
    const input = timeEntriesCreate.input.parse({
      entries: [{ entry_date: '2026-11-02', hours: 3, customer: 'Nordstjernan', project: 'p12', activity: 'bokslut' }],
    })
    const outcome = await timeEntriesCreate.run(ctx, input, { dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a preview')
    const [entry] = outcome.preview.entries as Array<Record<string, unknown>>
    expect(entry).toMatchObject({
      weekday: 'måndag',
      consultant: 'AB',
      customer_id: OTHER_CUSTOMER,
      customer_name: 'Rederi Nordstjernan AB',
      project_code: 'P12',
      activity_code: '2',
      hourly_rate: 1200,
      amount: 3600,
    })
    expect(entry.matched).toEqual([expect.objectContaining({ field: 'customer', input: 'Nordstjernan' })])
    expect(outcome.preview).toMatchObject({ total_hours: 3, total_amount: 3600 })
    expect(mock.findCall('time_entries', 'insert')).toBeUndefined()

    // The staged params name every reference by id or code, so the commit registers what was approved.
    const pinned = createStage.pinParams!(input as Record<string, unknown>, outcome.preview)
    expect(pinned).toEqual({
      entries: [{
        entry_date: '2026-11-02', hours: 3, customer_id: OTHER_CUSTOMER, project: 'P12', activity: '2',
        consultant: 'AB', comment: null, is_billable: true,
      }],
    })
    expect(timeEntriesCreate.input.safeParse(pinned).success).toBe(true)
    expect(createStage.title(input as Record<string, unknown>)).toBe('Registrera 3 h den 2026-11-02')
  })

  it('refuses an ambiguous customer with candidates and names the entry in a batch', async () => {
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: [...customerRows, { id: 'c-x', name: 'Galärbryggan Event AB', customer_number: null }] })
    const input = timeEntriesCreate.input.parse({
      entries: [
        { entry_date: '2026-11-02', hours: 1, customer_id: CUSTOMER_ID },
        { entry_date: '2026-11-02', hours: 1, customer: 'Galärbryggan' },
      ],
    })
    const outcome = await timeEntriesCreate.run(ctx, input, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'TIME_ENTRY_REFERENCE_UNRESOLVED',
      details: { field: 'customer', entry_index: 1 },
    })
    if (outcome.ok) return
    expect(outcome.messageSv).toMatch(/Galärbryggan AB/)
  })

  it('does not take an unregistered activity code over the machine doors', async () => {
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: customerRows })
    const input = timeEntriesCreate.input.parse({
      entries: [{ entry_date: '2026-11-02', hours: 1, customer_id: CUSTOMER_ID, activity: 'X9' }],
    })
    const outcome = await timeEntriesCreate.run(ctx, input, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'TIME_ENTRY_REFERENCE_UNRESOLVED', details: { field: 'activity' } })
  })

  it('asks for the consultant when the caller is not linked to one', async () => {
    mock.enqueue({ data: { value: { ...registers, consultants: [{ code: 'CD', name: 'Carl Dahl' }] } } })
    mock.enqueue({ data: customerRows })
    const input = timeEntriesCreate.input.parse({ entries: [{ entry_date: '2026-11-02', hours: 1, customer_id: CUSTOMER_ID }] })
    const outcome = await timeEntriesCreate.run(ctx, input, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'TIME_ENTRY_CONSULTANT_REQUIRED',
      details: { consultants: [{ code: 'CD', name: 'Carl Dahl' }] },
    })
  })

  it('refuses a customer_id of another company', async () => {
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: customerRows })
    const input = timeEntriesCreate.input.parse({
      entries: [{ entry_date: '2026-11-02', hours: 1, customer_id: '44444444-4444-4444-8444-444444444444' }],
    })
    expect(await timeEntriesCreate.run(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code: 'TIME_ENTRY_CUSTOMER_NOT_FOUND' })
  })

  it('commits the pinned entries as one insert for the acting user', async () => {
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: customerRows })
    mock.enqueue({ data: [row({ hours: '2' }), row({ id: '66666666-6666-4666-8666-666666666666', hours: '1' })] })
    const input = timeEntriesCreate.input.parse({
      entries: [
        { entry_date: '2026-10-14', hours: 2, customer_id: CUSTOMER_ID, consultant: 'AB', activity: '1' },
        { entry_date: '2026-10-15', hours: 1, customer_id: CUSTOMER_ID, consultant: 'CD', is_billable: false },
      ],
    })
    const outcome = await timeEntriesCreate.run(ctx, input, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.created).toBe(true)
    const inserted = mock.findCall('time_entries', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(inserted).toHaveLength(2)
    expect(inserted[1]).toMatchObject({ company_id: 'company-1', user_id: 'user-1', consultant: 'CD', is_billable: false, source: 'manual' })
    expect(outcome.data.entries[0]).toMatchObject({ time_entry_id: ENTRY_ID, hours: 2 })
    expect(timeEntriesCreate.output.safeParse(outcome.data).success).toBe(true)
  })
})

describe('time-entries.update', () => {
  it('needs a field to change and not both customer forms', () => {
    expect(() => timeEntriesUpdate.input.parse({ time_entry_id: ENTRY_ID })).toThrow()
    expect(() => timeEntriesUpdate.input.parse({ time_entry_id: ENTRY_ID, customer: 'x', customer_id: CUSTOMER_ID })).toThrow()
    expect(timeEntriesUpdate.input.parse({ time_entry_id: ENTRY_ID, project: null })).toEqual({ time_entry_id: ENTRY_ID, project: null })
  })

  it('refuses an invoiced entry', async () => {
    mock.enqueue({ data: row({ invoice_id: '55555555-5555-4555-8555-555555555555' }) })
    const outcome = await timeEntriesUpdate.run(ctx, { time_entry_id: ENTRY_ID, hours: 1 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'TIME_ENTRY_INVOICED' })
  })

  it('answers not found for an entry outside the company', async () => {
    mock.enqueue({ data: null })
    const outcome = await timeEntriesUpdate.run(ctx, { time_entry_id: ENTRY_ID, hours: 1 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'TIME_ENTRY_NOT_FOUND' })
  })

  it('previews before and after and pins only the resolved changes', async () => {
    mock.enqueue({ data: row() })
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: customerRows })
    const input = timeEntriesUpdate.input.parse({ time_entry_id: ENTRY_ID, hours: 2, customer: '1001', project: null })
    const outcome = await timeEntriesUpdate.run(ctx, input, { dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a preview')
    expect(outcome.preview).toMatchObject({
      before: { hours: 3.5, project_code: 'P12' },
      after: { hours: 2, project_code: null, customer_id: CUSTOMER_ID, customer_name: 'Galärbryggan AB' },
      changes: { hours: 2, customer_id: CUSTOMER_ID, project: null },
    })
    expect(updateStage.pinParams!(input as Record<string, unknown>, outcome.preview)).toEqual({
      time_entry_id: ENTRY_ID,
      hours: 2,
      customer_id: CUSTOMER_ID,
      project: null,
    })
  })

  it('writes only while the entry is uninvoiced, and reports a row invoiced since the read', async () => {
    mock.enqueue({ data: row() })
    mock.enqueue({ data: { value: registers } })
    mock.enqueue({ data: null })
    const outcome = await timeEntriesUpdate.run(ctx, { time_entry_id: ENTRY_ID, hours: 2 }, { dryRun: false })
    expect(mock.findCalls('time_entries', 'is')).toContainEqual(['invoice_id', null])
    expect(outcome).toMatchObject({ ok: false, code: 'TIME_ENTRY_INVOICED' })
  })
})

describe('time-entries.delete', () => {
  it('previews the entry it will delete and refuses an invoiced one', async () => {
    mock.enqueue({ data: row() })
    const preview = await timeEntriesDelete.run(ctx, { time_entry_id: ENTRY_ID }, { dryRun: true })
    expect(preview).toMatchObject({ ok: true, dryRun: true, preview: { time_entry_id: ENTRY_ID, entry: { hours: 3.5 } } })
    expect(mock.findCall('time_entries', 'delete')).toBeUndefined()

    mock.enqueue({ data: row({ invoice_id: '55555555-5555-4555-8555-555555555555' }) })
    expect(await timeEntriesDelete.run(ctx, { time_entry_id: ENTRY_ID }, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'TIME_ENTRY_INVOICED',
    })
  })

  it('deletes an uninvoiced entry of the company', async () => {
    mock.enqueue({ data: row() })
    mock.enqueue({ data: [{ id: ENTRY_ID }] })
    const outcome = await timeEntriesDelete.run(ctx, { time_entry_id: ENTRY_ID }, { dryRun: false })
    expect(outcome).toEqual({ ok: true, data: { deleted: true, time_entry_id: ENTRY_ID } })
    expect(mock.findCalls('time_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
  })
})
