import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { eventBus } from '@/lib/events/bus'
import { tools } from '../server'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222'

const listTool = () => tools.find((t) => t.name === 'gnubok_list_recurring_schedules')!
const createTool = () => tools.find((t) => t.name === 'gnubok_create_recurring_schedule')!
const updateTool = () => tools.find((t) => t.name === 'gnubok_update_recurring_schedule')!

function currentSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    name: 'Månadsavgift',
    status: 'active',
    customer_id: CUSTOMER_ID,
    day_of_month: 25,
    send_hour: 8,
    payment_terms_days: 30,
    currency: 'SEK',
    your_reference: null,
    our_reference: null,
    notes: null,
    auto_send: false,
    next_run_date: '2999-01-25',
    customer: { name: 'Test Customer AB', email: 'billing@example.test' },
    items: [
      { description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: null, sort_order: 0 },
    ],
    ...overrides,
  }
}

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
  it('returns qualified ids and sorted items', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: SCHEDULE_ID,
          name: 'Månadsavgift',
          status: 'active',
          customer_id: CUSTOMER_ID,
          day_of_month: 31,
          send_hour: 8,
          payment_terms_days: 30,
          currency: 'SEK',
          auto_send: false,
          next_run_date: '2026-08-31',
          last_run_at: null,
          last_invoice_id: null,
          last_run_warning: null,
          generated_count: 0,
          customer: { name: 'Test Customer AB' },
          items: [
            { description: 'Timmar', quantity: 1, unit: 'tim', unit_price: 50, vat_rate: 25, sort_order: 1 },
            { description: 'Support', quantity: 2, unit: 'st', unit_price: 100, vat_rate: null, sort_order: 0 },
          ],
        },
      ],
      count: 1,
    })

    const result = (await listTool().execute({}, 'company-1', 'user-1', supabase as never)) as {
      schedules: Array<Record<string, unknown>>
      count: number
      total_count: number
    }

    expect(result.count).toBe(1)
    expect(result.total_count).toBe(1)
    const row = result.schedules[0]
    expect(row.recurring_schedule_id).toBe(SCHEDULE_ID)
    expect(row).not.toHaveProperty('id')
    expect(row.customer_id).toBe(CUSTOMER_ID)
    expect(row.customer_name).toBe('Test Customer AB')
    expect(row.last_invoice_id).toBeNull()
    expect(row.monthly_total_excl_vat).toBe(250)
    expect((row.items as Array<{ description: string }>).map((i) => i.description)).toEqual([
      'Support',
      'Timmar',
    ])
  })
})

describe('gnubok_create_recurring_schedule: validation and staging', () => {
  const validArgs = {
    customer_id: CUSTOMER_ID,
    name: 'Månadsavgift',
    day_of_month: 25,
    items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000 }],
  }

  it('rejects missing items before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createTool().execute(
        { customer_id: CUSTOMER_ID, name: 'X', day_of_month: 25 },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/items/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a VAT rate outside the Swedish set before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createTool().execute(
        {
          ...validArgs,
          items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: 10 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/vat_rate/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the customer is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      createTool().execute({ ...validArgs, dry_run: true }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not found/i)
  })

  it('rejects auto_send when the customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CUSTOMER_ID, name: 'Test Customer AB', email: null } })

    await expect(
      createTool().execute(
        { ...validArgs, auto_send: true, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/email/i)
  })

  it('defaults auto_send to false and surfaces it explicitly in the dry-run preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CUSTOMER_ID, name: 'Test Customer AB', email: 'billing@example.test' } })

    const result = (await createTool().execute(
      { ...validArgs, dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.auto_send).toBe(false)
    expect(result.preview.monthly_total_excl_vat).toBe(5000)
    expect(result.preview.projected_first_run_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Preview only: nothing staged.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('stages the schedule for approval at medium risk', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CUSTOMER_ID, name: 'Test Customer AB', email: 'billing@example.test' } })
    enqueue({ data: { id: 'op-recurring-1' } })

    const result = (await createTool().execute(validArgs, 'company-1', 'user-1', supabase as never)) as {
      staged: boolean
      operation_id?: string
      risk_level: string
      preview: Record<string, unknown>
    }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-recurring-1',
      risk_level: 'medium',
    })
    expect(result.preview.auto_send).toBe(false)
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
  })

  it('stages an explicit auto_send=true at HIGH risk with the flag visible in the preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: CUSTOMER_ID, name: 'Test Customer AB', email: 'billing@example.test' } })
    enqueue({ data: { id: 'op-recurring-2' } })

    const result = (await createTool().execute(
      { ...validArgs, auto_send: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.auto_send).toBe(true)
    // Param escalation (risk-tiers paramEscalatedRisk): an auto-sending
    // schedule is a standing order for outbound customer email with no
    // per-send approval, the same external side-effect that puts one-off
    // send_invoice at 'high'. The static tier stays 'medium' (asserted
    // above); the staged operation must carry the escalated level so
    // auto-commit can never touch it and approval requires confirmed=true.
    expect(result.risk_level).toBe('high')
  })
})

describe('gnubok_update_recurring_schedule: validation and staging', () => {
  it('requires at least one changed field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute({ schedule_id: SCHEDULE_ID, dry_run: true }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an unknown status before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute(
        { schedule_id: SCHEDULE_ID, status: 'stopped', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/status/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the schedule is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      updateTool().execute(
        { schedule_id: SCHEDULE_ID, status: 'paused', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('rejects enabling auto_send when the current customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule({ customer: { name: 'Test Customer AB', email: null } }) })

    await expect(
      updateTool().execute(
        { schedule_id: SCHEDULE_ID, auto_send: true, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/email/i)
  })

  it('stages an update that enables auto_send at HIGH risk', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule() }) // current has auto_send: false + customer email
    enqueue({ data: { id: 'op-recurring-4' } })

    const result = (await updateTool().execute(
      { schedule_id: SCHEDULE_ID, auto_send: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; risk_level: string }

    expect(result.staged).toBe(true)
    // Same escalation as the create tool: turning auto_send on converts the
    // schedule into recurring outbound email, so the staged op is 'high'.
    expect(result.risk_level).toBe('high')
  })

  it('stages a pause via the status field', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule() })
    enqueue({ data: { id: 'op-recurring-3' } })

    const result = (await updateTool().execute(
      { schedule_id: SCHEDULE_ID, status: 'paused' },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      operation_id?: string
      preview: { current: Record<string, unknown>; proposed: Record<string, unknown> }
    }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-recurring-3')
    expect(result.preview.current.status).toBe('active')
    expect(result.preview.proposed.status).toBe('paused')
    expect(result.preview.current.recurring_schedule_id).toBe(SCHEDULE_ID)
  })

  it('stages an explicit next_run_date so an agent can re-phase a yearly schedule', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule({ interval_months: 12 }) })
    enqueue({ data: { id: 'op-recurring-5' } })

    const result = (await updateTool().execute(
      { schedule_id: SCHEDULE_ID, next_run_date: '2999-02-25' },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: { current: Record<string, unknown>; proposed: Record<string, unknown> }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.current.next_run_date).toBe('2999-01-25')
    expect(result.preview.proposed.next_run_date).toBe('2999-02-25')
  })

  it('rejects a malformed next_run_date before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute(
        { schedule_id: SCHEDULE_ID, next_run_date: 'februari', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/next_run_date/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('previews an item replace against the current lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule() })

    const result = (await updateTool().execute(
      {
        schedule_id: SCHEDULE_ID,
        items: [{ description: 'Ny rad', quantity: 2, unit: 'tim', unit_price: 1200 }],
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      dry_run?: boolean
      preview: {
        current: { items: Array<{ description: string }> }
        proposed: { items: Array<{ description: string }> }
      }
    }

    expect(result.dry_run).toBe(true)
    expect(result.preview.current.items.map((i) => i.description)).toEqual(['Support'])
    expect(result.preview.proposed.items.map((i) => i.description)).toEqual(['Ny rad'])
  })

  it('verifies a new customer belongs to the company', async () => {
    const otherCustomerId = '33333333-3333-4333-8333-333333333333'
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule() })
    enqueue({ data: null })

    await expect(
      updateTool().execute(
        { schedule_id: SCHEDULE_ID, customer_id: otherCustomerId, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'customers')
  })
})

describe('recurring schedule tools: dimension bags', () => {
  const PROJEKT_DIM = {
    id: 'dim-6',
    sie_dim_no: 6,
    name: 'Projekt',
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

  /**
   * The queued mock's chain proxy discards call args by design, so capture
   * .insert payloads per table with a thin wrapper around the original
   * implementation. Lets the tests assert what actually lands in
   * pending_operations.params.
   */
  function captureInserts(supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) {
    const inserted: Record<string, unknown[]> = {}
    const originalFrom = supabase.from.getMockImplementation()!
    supabase.from.mockImplementation((table: string) => {
      const chain = originalFrom(table) as object
      return new Proxy(chain, {
        get(target, prop, receiver) {
          if (prop === 'insert') {
            return (rows: unknown) => {
              ;(inserted[table] ??= []).push(rows)
              return (Reflect.get(target, prop, receiver) as (r: unknown) => unknown)(rows)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    })
    return inserted
  }

  it('create: stages schedule + item bags verbatim while dimensions are disabled (free-text passthrough)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserted = captureInserts(supabase)
    enqueue({ data: { dimensions_enabled: false } }) // company_settings (resolver)
    enqueue({ data: { id: CUSTOMER_ID, name: 'Test Customer AB', email: 'billing@example.test' } })
    enqueue({ data: { id: 'op-dims-1' } }) // pending_operations insert

    const result = (await createTool().execute(
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
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const opRow = inserted['pending_operations'][0] as { params: Record<string, unknown> }
    expect(opRow.params.default_dimensions).toEqual({ '1': 'KS1' })
    const items = opRow.params.items as Array<Record<string, unknown>>
    expect(items[0].dimensions).toEqual({ '6': 'P001' })
    // Untagged template items stage without the key: the commit executor and
    // the cron both treat a missing bag as {}.
    expect(items[1]).not.toHaveProperty('dimensions')
    expect(result.preview.default_dimensions).toEqual({ '1': 'KS1' })
  })

  it('create: resolves a value NAME to its registry code and echoes the resolution', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserted = captureInserts(supabase)
    enqueue({ data: { dimensions_enabled: true } }) // company_settings
    enqueue({ data: null }) // ensure_company_dimensions rpc
    enqueue({ data: [PROJEKT_DIM] }) // dimensions
    enqueue({ data: [PROJEKT_VALUE] }) // dimension_values
    enqueue({ data: { id: CUSTOMER_ID, name: 'Test Customer AB', email: 'billing@example.test' } })
    enqueue({ data: { id: 'op-dims-2' } })

    const result = (await createTool().execute(
      {
        customer_id: CUSTOMER_ID,
        name: 'Villaprojektet',
        day_of_month: 25,
        default_dimensions: { '6': 'Villa Almgren' },
        items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const opRow = inserted['pending_operations'][0] as { params: Record<string, unknown> }
    expect(opRow.params.default_dimensions).toEqual({ '6': 'P001' })
    const resolutions = result.preview.dimension_resolutions as Array<Record<string, unknown>>
    expect(resolutions.length).toBeGreaterThan(0)
  })

  it('create: rejects an unknown dimension value instead of auto-creating it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: true } })
    enqueue({ data: null })
    enqueue({ data: [PROJEKT_DIM] })
    enqueue({ data: [PROJEKT_VALUE] })

    await expect(
      createTool().execute(
        {
          customer_id: CUSTOMER_ID,
          name: 'X',
          day_of_month: 25,
          default_dimensions: { '6': 'Helt Okänt Projekt' },
          items: [{ description: 'S', quantity: 1, unit: 'st', unit_price: 100 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/matcha|Kandidater|gnubok_create_dimension_value/i)
  })

  it('update: stages {} as the clear-all-tags bag replace', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentSchedule() })
    enqueue({ data: { id: 'op-dims-3' } })

    const result = (await updateTool().execute(
      { schedule_id: SCHEDULE_ID, default_dimensions: {} },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        current: Record<string, unknown>
        changes: Record<string, unknown>
        proposed: Record<string, unknown>
      }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.changes.default_dimensions).toEqual({})
    expect(result.preview.proposed.default_dimensions).toEqual({})
  })
})
