/**
 * The recurring invoice schedule tools, generated from the operations in
 * src/lib/operations/recurring-invoice-schedules.ts (operation-tools.ts):
 * gnubok_list_recurring_schedules reads, gnubok_create_recurring_schedule and
 * gnubok_update_recurring_schedule stage what their v1 endpoints write. The
 * MCP door adds one thing of its own: a dimension value may be given by its
 * name and is resolved to its code before the operation runs
 * (prepareRecurringScheduleDimensions in ../server.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { eventBus } from '@/lib/events/bus'
import { tools } from '../server'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222'
const ARTICLE_ID = '33333333-3333-4333-8333-333333333333'

const listTool = () => tools.find((t) => t.name === 'gnubok_list_recurring_schedules')!
const createTool = () => tools.find((t) => t.name === 'gnubok_create_recurring_schedule')!
const updateTool = () => tools.find((t) => t.name === 'gnubok_update_recurring_schedule')!

const CUSTOMER = { id: CUSTOMER_ID, name: 'Test Customer AB', email: 'billing@example.test' }

function currentSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    name: 'Månadsavgift',
    status: 'active',
    customer_id: CUSTOMER_ID,
    day_of_month: 25,
    interval_months: 1,
    send_hour: 8,
    payment_terms_days: 30,
    currency: 'SEK',
    your_reference: null,
    our_reference: null,
    notes: null,
    period_start: null,
    auto_send: false,
    default_dimensions: {},
    next_run_date: '2999-01-25',
    customer: { name: 'Test Customer AB', email: 'billing@example.test' },
    items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: null, sort_order: 0 }],
    ...overrides,
  }
}

type Tables = Record<string, TableMockResult | TableMockResult[] | TableMockResolver>

/** One company's database; pending_operations answers the staged row. */
function db(tables: Tables = {}) {
  return createTableMockSupabase({
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      return { data: insert ? { id: 'op-recurring-1', ...(insert.args[0] as object) } : null }
    },
    ...tables,
  })
}

type Tool = ReturnType<typeof listTool>
const run = (tool: Tool, args: Record<string, unknown>, mock: ReturnType<typeof db>) =>
  tool.execute(args, 'company-1', 'user-1', mock.supabase as never) as Promise<Record<string, unknown>>

const staged = (mock: ReturnType<typeof db>) => mock.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('recurring schedule tools: registration', () => {
  it('registers all three tools with strict input schemas', () => {
    for (const tool of [listTool(), createTool(), updateTool()]) {
      expect(tool).toBeDefined()
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    expect(listTool().annotations.readOnlyHint).toBe(true)
    expect(createTool().annotations.readOnlyHint).toBe(false)
    expect(updateTool().annotations.readOnlyHint).toBe(false)
    expect((updateTool().inputSchema as { required?: string[] }).required).toEqual(['schedule_id'])
  })

  it('maps scopes and risk tiers', () => {
    expect(TOOL_SCOPE_MAP.gnubok_list_recurring_schedules).toBe('invoices:read')
    expect(TOOL_SCOPE_MAP.gnubok_create_recurring_schedule).toBe('invoices:write')
    expect(TOOL_SCOPE_MAP.gnubok_update_recurring_schedule).toBe('invoices:write')
    expect(OPERATION_RISK_TIERS.create_recurring_schedule).toBe('medium')
    expect(OPERATION_RISK_TIERS.update_recurring_schedule).toBe('medium')
  })

  it('both writes declare the staged-operation output contract', () => {
    for (const tool of [createTool(), updateTool()]) {
      const schema = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(schema?.properties?.staged).toBeDefined()
      expect(schema?.required).toContain('staged')
    }
  })

  it('descriptions state day-of-month clamping and Stockholm send hour', () => {
    for (const tool of [listTool(), createTool(), updateTool()]) {
      expect(tool.description).toMatch(/clamps to the last day in shorter months/i)
      expect(tool.description).toMatch(/Europe\/Stockholm/i)
    }
  })
})

describe('gnubok_list_recurring_schedules', () => {
  it('returns qualified ids and sorted items, and the article each line links', async () => {
    const mock = db({
      recurring_invoice_schedules: {
        data: [
          currentSchedule({
            items: [
              { description: 'Timmar', quantity: 1, unit: 'tim', unit_price: 50, vat_rate: 25, sort_order: 1, article_id: ARTICLE_ID },
              // A row read before migration 20261101003800 has no article_id key.
              { description: 'Support', quantity: 2, unit: 'st', unit_price: 100, vat_rate: null, sort_order: 0 },
            ],
          }),
        ],
        count: 1,
      },
    })
    const result = (await run(listTool(), {}, mock)) as { schedules: Array<Record<string, unknown>> }
    expect(result).toMatchObject({ count: 1, total_count: 1, has_more: false })
    const row = result.schedules[0]
    expect(row.recurring_schedule_id).toBe(SCHEDULE_ID)
    expect(row).not.toHaveProperty('id')
    expect(row).toMatchObject({ customer_id: CUSTOMER_ID, customer_name: 'Test Customer AB', last_invoice_id: null, monthly_total_excl_vat: 250 })
    const items = row.items as Array<{ description: string; article_id: string | null }>
    expect(items.map((i) => i.description)).toEqual(['Support', 'Timmar'])
    expect(items.map((i) => i.article_id)).toEqual([null, ARTICLE_ID])
    // '*' on the line join: tolerates the column not being migrated yet.
    expect(String(mock.findCall('recurring_invoice_schedules', 'select')?.[0])).toContain('recurring_invoice_schedule_items(*)')
  })
})

describe('gnubok_create_recurring_schedule: validation and staging', () => {
  const validArgs = {
    customer_id: CUSTOMER_ID,
    name: 'Månadsavgift',
    day_of_month: 25,
    items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000 }],
  }

  it('rejects missing items and a VAT rate outside the Swedish set before querying the database', async () => {
    const mock = db()
    await expect(run(createTool(), { customer_id: CUSTOMER_ID, name: 'X', day_of_month: 25 }, mock)).rejects.toThrow()
    await expect(
      run(createTool(), { ...validArgs, items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: 10 }] }, mock),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mock.calls).toEqual([])
  })

  it('fails when the customer is outside the selected company', async () => {
    const mock = db({ customers: { data: null } })
    await expect(run(createTool(), { ...validArgs, dry_run: true }, mock)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' })
    expect(mock.findCalls('customers', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('rejects auto_send when the customer has no email', async () => {
    const mock = db({ customers: { data: { ...CUSTOMER, email: null } } })
    await expect(run(createTool(), { ...validArgs, auto_send: true, dry_run: true }, mock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'auto_send' },
    })
  })

  it('defaults auto_send to false and surfaces it explicitly in the dry-run preview', async () => {
    const mock = db({ customers: { data: CUSTOMER } })
    const result = await run(createTool(), { ...validArgs, dry_run: true }, mock)
    expect(result).toMatchObject({ staged: false, dry_run: true })
    const preview = result.preview as Record<string, unknown>
    expect(preview.auto_send).toBe(false)
    expect(preview.monthly_total_excl_vat).toBe(5000)
    expect(preview.projected_first_run_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(staged(mock)).toHaveLength(0)
  })

  it.each([
    { start_date: '2999-09-10', day_of_month: 1 },
    { start_date: '2020-01-25', day_of_month: 25 },
  ])('rejects start_date $start_date (off the grid or in the past) at staging', async ({ start_date, day_of_month }) => {
    const mock = db({ customers: { data: CUSTOMER } })
    await expect(run(createTool(), { ...validArgs, day_of_month, start_date }, mock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'start_date' },
    })
    expect(staged(mock)).toHaveLength(0)
  })

  it('stages the schedule for approval at medium risk, with the follow-up call', async () => {
    const mock = db({ customers: { data: CUSTOMER } })
    const result = await run(createTool(), validArgs, mock)
    expect(result).toMatchObject({ staged: true, operation_id: 'op-recurring-1', risk_level: 'medium' })
    expect((result.preview as Record<string, unknown>).auto_send).toBe(false)
    expect(staged(mock)[0]).toMatchObject({
      operation_type: 'create_recurring_schedule',
      title: 'Nytt återkommande fakturaschema: Månadsavgift',
    })
    expect(JSON.stringify(result)).toContain('gnubok_list_recurring_schedules')
  })

  it('stages an explicit auto_send=true at HIGH risk with the flag visible in the preview', async () => {
    const mock = db({ customers: { data: CUSTOMER } })
    const result = await run(createTool(), { ...validArgs, auto_send: true }, mock)
    expect(result.staged).toBe(true)
    expect((result.preview as Record<string, unknown>).auto_send).toBe(true)
    // An auto-sending schedule emails every invoice with no per-send
    // approval: the static tier stays medium, the staged row is high.
    expect(result.risk_level).toBe('high')
  })
})

describe('gnubok_update_recurring_schedule: validation and staging', () => {
  it('requires a changed field, a known status and a well-formed date, before querying the database', async () => {
    const mock = db()
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, dry_run: true }, mock)).rejects.toThrow()
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, status: 'stopped', dry_run: true }, mock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, next_run_date: 'februari', dry_run: true }, mock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    expect(mock.calls).toEqual([])
  })

  it('fails when the schedule is outside the selected company', async () => {
    const mock = db({ recurring_invoice_schedules: { data: null } })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, status: 'paused', dry_run: true }, mock)).rejects.toMatchObject({
      code: 'RECURRING_SCHEDULE_NOT_FOUND',
    })
    expect(mock.findCalls('recurring_invoice_schedules', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('rejects enabling auto_send when the current customer has no email', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule({ customer: { name: 'Test Customer AB', email: null } }) } })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, auto_send: true, dry_run: true }, mock)).rejects.toMatchObject({
      details: { field: 'auto_send' },
    })
  })

  it('stages an update that enables auto_send at HIGH risk, with flat params', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() } })
    const result = await run(updateTool(), { schedule_id: SCHEDULE_ID, auto_send: true }, mock)
    expect(result).toMatchObject({ staged: true, risk_level: 'high' })
    expect(staged(mock)[0].params).toEqual({ schedule_id: SCHEDULE_ID, auto_send: true })
  })

  it('stages a pause via the status field', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() } })
    const result = await run(updateTool(), { schedule_id: SCHEDULE_ID, status: 'paused' }, mock)
    expect(result).toMatchObject({ staged: true, operation_id: 'op-recurring-1' })
    const preview = result.preview as { current: Record<string, unknown>; proposed: Record<string, unknown> }
    expect(preview.current).toMatchObject({ status: 'active', recurring_schedule_id: SCHEDULE_ID })
    expect(preview.proposed.status).toBe('paused')
    expect(staged(mock)[0].title).toBe('Uppdatera återkommande fakturaschema: Månadsavgift')
  })

  it('stages an explicit next_run_date so an agent can re-phase a yearly schedule', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule({ interval_months: 12 }) } })
    const result = await run(updateTool(), { schedule_id: SCHEDULE_ID, next_run_date: '2999-02-25' }, mock)
    const preview = result.preview as { current: Record<string, unknown>; proposed: Record<string, unknown> }
    expect(preview.current.next_run_date).toBe('2999-01-25')
    expect(preview.proposed.next_run_date).toBe('2999-02-25')
  })

  it('checks next_run_date against the day_of_month in effect, a new one included', async () => {
    const offGrid = db({ recurring_invoice_schedules: { data: currentSchedule({ day_of_month: 15 }) } })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, next_run_date: '2999-11-01' }, offGrid)).rejects.toMatchObject({
      details: { field: 'next_run_date' },
    })
    expect(staged(offGrid)).toHaveLength(0)

    const moved = db({ recurring_invoice_schedules: { data: currentSchedule({ day_of_month: 15 }) } })
    const result = await run(updateTool(), { schedule_id: SCHEDULE_ID, day_of_month: 1, next_run_date: '2999-11-01' }, moved)
    expect((result.preview as { proposed: Record<string, unknown> }).proposed).toMatchObject({ day_of_month: 1, next_run_date: '2999-11-01' })
  })

  it('rejects a next_run_date that is not after today at staging', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() } })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, next_run_date: '2020-01-25' }, mock)).rejects.toMatchObject({
      details: { field: 'next_run_date' },
    })
    expect(staged(mock)).toHaveLength(0)
  })

  it('previews an item replace against the current lines', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() } })
    const result = await run(
      updateTool(),
      { schedule_id: SCHEDULE_ID, items: [{ description: 'Ny rad', quantity: 2, unit: 'tim', unit_price: 1200 }], dry_run: true },
      mock,
    )
    const preview = result.preview as { current: { items: Array<{ description: string }> }; proposed: { items: Array<{ description: string }> } }
    expect(result.dry_run).toBe(true)
    expect(preview.current.items.map((i) => i.description)).toEqual(['Support'])
    expect(preview.proposed.items.map((i) => i.description)).toEqual(['Ny rad'])
  })

  it('verifies a new customer belongs to the company', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() }, customers: { data: null } })
    await expect(
      run(updateTool(), { schedule_id: SCHEDULE_ID, customer_id: '44444444-4444-4444-8444-444444444444', dry_run: true }, mock),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' })
    expect(mock.findCalls('customers', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('refuses period placeholders without a period_start in effect at staging, as the approval would', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() } })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, notes: 'Avser {periodstart} till {periodslut}' }, mock)).rejects.toMatchObject({
      details: { field: 'period_start' },
    })
    expect(staged(mock)).toHaveLength(0)
  })
})

describe('recurring schedule tools: dimension bags', () => {
  const PROJEKT_DIM = {
    id: 'dim-6',
    sie_dim_no: 6,
    name: 'Projekt',
    parent_sie_dim_no: null,
    resets_annually: false,
    is_system: true,
    is_active: true,
    sort_order: 2,
  }
  const PROJEKT_VALUE = {
    id: 'dv-1',
    dimension_id: 'dim-6',
    code: 'P001',
    name: 'Villa Almgren',
    is_active: true,
    start_date: null,
    end_date: null,
  }
  const registry = (enabled: boolean): Tables => ({
    company_settings: { data: { dimensions_enabled: enabled } },
    dimensions: { data: [PROJEKT_DIM] },
    dimension_values: { data: [PROJEKT_VALUE] },
  })

  it('create: stages schedule and line bags verbatim while dimensions are disabled (free-text passthrough)', async () => {
    const mock = db({ ...registry(false), customers: { data: CUSTOMER } })
    const result = await run(
      createTool(),
      {
        customer_id: CUSTOMER_ID,
        name: 'Projekt-retainer',
        day_of_month: 25,
        default_dimensions: { '1': 'KS1' },
        items: [
          { description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, dimensions: { '6': 'P001' } },
          { description: 'Timmar', quantity: 2, unit: 'tim', unit_price: 1000 },
        ],
      },
      mock,
    )
    expect(result.staged).toBe(true)
    const params = staged(mock)[0].params as Record<string, unknown>
    expect(params.default_dimensions).toEqual({ '1': 'KS1' })
    const items = params.items as Array<Record<string, unknown>>
    expect(items[0].dimensions).toEqual({ '6': 'P001' })
    // An untagged line stages without the key: the commit and the cron read a missing bag as {}.
    expect(items[1]).not.toHaveProperty('dimensions')
    expect((result.preview as Record<string, unknown>).default_dimensions).toEqual({ '1': 'KS1' })
  })

  it('create: resolves a value NAME to its registry code and echoes the resolution', async () => {
    const mock = db({ ...registry(true), customers: { data: CUSTOMER } })
    const result = await run(
      createTool(),
      {
        customer_id: CUSTOMER_ID,
        name: 'Villaprojektet',
        day_of_month: 25,
        default_dimensions: { '6': 'Villa Almgren' },
        items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000 }],
      },
      mock,
    )
    expect(result.staged).toBe(true)
    expect((staged(mock)[0].params as Record<string, unknown>).default_dimensions).toEqual({ '6': 'P001' })
    const resolutions = (result.preview as Record<string, unknown>).dimension_resolutions as Array<Record<string, unknown>>
    expect(resolutions).toEqual([expect.objectContaining({ dimension: 6, input: 'Villa Almgren', resolved_code: 'P001' })])
  })

  it('create: rejects an unknown dimension value instead of auto-creating it', async () => {
    const mock = db({ ...registry(true), customers: { data: CUSTOMER } })
    await expect(
      run(
        createTool(),
        {
          customer_id: CUSTOMER_ID,
          name: 'X',
          day_of_month: 25,
          default_dimensions: { '6': 'Helt Okänt Projekt' },
          items: [{ description: 'S', quantity: 1, unit: 'st', unit_price: 100 }],
        },
        mock,
      ),
    ).rejects.toThrow(/matcha|Kandidater|gnubok_create_dimension_value/i)
    expect(staged(mock)).toHaveLength(0)
  })

  it('update: stages {} as the clear-all-tags bag replace', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule({ default_dimensions: { '6': 'P001' } }) } })
    const result = await run(updateTool(), { schedule_id: SCHEDULE_ID, default_dimensions: {} }, mock)
    expect(result.staged).toBe(true)
    const preview = result.preview as { changes: Record<string, unknown>; proposed: Record<string, unknown> }
    expect(preview.changes.default_dimensions).toEqual({})
    expect(preview.proposed.default_dimensions).toEqual({})
    expect(staged(mock)[0].params).toEqual({ schedule_id: SCHEDULE_ID, default_dimensions: {} })
  })
})

describe('recurring schedule tools: article links (accounted#52)', () => {
  const createArgs = {
    customer_id: CUSTOMER_ID,
    name: 'Hosting',
    day_of_month: 25,
    items: [{ description: 'Hosting', quantity: 1, unit: 'st', unit_price: 500, article_id: ARTICLE_ID }],
  }

  it('create: stages a line linked to one of the company\'s articles', async () => {
    const mock = db({ customers: { data: CUSTOMER }, articles: { data: [{ id: ARTICLE_ID }] } })
    const result = await run(createTool(), createArgs, mock)
    expect(result.staged).toBe(true)
    expect((result.preview as { items: Array<{ article_id?: string }> }).items[0].article_id).toBe(ARTICLE_ID)
    expect(mock.findCalls('articles', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('create: refuses another company\'s article at staging', async () => {
    const mock = db({ customers: { data: CUSTOMER }, articles: { data: [] } })
    await expect(run(createTool(), createArgs, mock)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'items', article_ids: [ARTICLE_ID] },
    })
    expect(staged(mock)).toHaveLength(0)
  })

  it('update: refuses another company\'s article in replacement lines', async () => {
    const mock = db({ recurring_invoice_schedules: { data: currentSchedule() }, articles: { data: [] } })
    await expect(run(updateTool(), { schedule_id: SCHEDULE_ID, items: createArgs.items }, mock)).rejects.toMatchObject({
      details: { field: 'items' },
    })
    expect(staged(mock)).toHaveLength(0)
  })
})
