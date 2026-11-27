/**
 * Recurring invoice schedules through the v1 door of the operation registry
 * (src/lib/operations/recurring-invoice-schedules.ts via lib/operations/v1.ts):
 *   GET   /api/v1/companies/:companyId/recurring-invoice-schedules
 *   POST  /api/v1/companies/:companyId/recurring-invoice-schedules
 *   PATCH /api/v1/companies/:companyId/recurring-invoice-schedules/:id
 *
 * The same operations the MCP tools run and the approval of a proposal
 * commits. Under test here: the door (key, scope, validation), the company
 * fence, a dry run writing nothing, the direct write, and ?stage=true
 * proposing the write as a pending operation instead of making it. The rules
 * themselves are lib/invoices/recurring-schedule-actions.ts's.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import { GET as listSchedules, POST as createSchedule } from '../route'
import { PATCH as updateSchedule } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222'
const PENDING_ID = '33333333-3333-4333-8333-333333333333'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/recurring-invoice-schedules`

const CUSTOMER = { id: CUSTOMER_ID, name: 'Kunden AB', email: 'faktura@example.test' }

function storedSchedule(overrides: Record<string, unknown> = {}) {
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
    last_run_at: null,
    last_invoice_id: null,
    last_run_warning: null,
    generated_count: 2,
    customer: { name: 'Kunden AB', email: 'faktura@example.test' },
    items: [{ line_type: 'product', description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: null, sort_order: 0, dimensions: {} }],
    ...overrides,
  }
}

type Tables = Record<string, TableMockResult | TableMockResult[] | TableMockResolver>

/** One request's database: the key's user is a member; the rest as given. */
function db(tables: Tables = {}) {
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'member' } },
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      return {
        data: insert ? { id: PENDING_ID, status: 'pending', created_at: '2026-11-27T10:00:00.000Z', ...(insert.args[0] as object) } : null,
      }
    },
    ...tables,
  })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

function request(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const scheduleParams = (id = SCHEDULE_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const CREATE_BODY = {
  customer_id: CUSTOMER_ID,
  name: 'Månadsavgift',
  day_of_month: 25,
  items: [{ description: 'Support {månad}', quantity: 1, unit: 'st', unit_price: 5000 }],
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const wroteSchedules = (mock: ReturnType<typeof db>) =>
  mock.calls.some((c) => (c.table === 'recurring_invoice_schedules' || c.table === 'recurring_invoice_schedule_items') && WRITES.has(c.method))

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Portal',
    scopes: ['invoices:read', 'invoices:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/recurring-invoice-schedules', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    db()
    expect((await listSchedules(request(BASE, 'GET'), companyParams)).status).toBe(401)
  })

  it('403 without invoices:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:read'], mode: 'live' })
    db()
    expect((await listSchedules(request(BASE, 'GET'), companyParams)).status).toBe(403)
  })

  it('400 on a status outside active and paused, and on a limit over 100', async () => {
    db()
    expect((await listSchedules(request(`${BASE}?status=stopped`, 'GET'), companyParams)).status).toBe(400)
    expect((await listSchedules(request(`${BASE}?limit=500`, 'GET'), companyParams)).status).toBe(400)
  })

  it('pages the company\'s schedules with qualified ids, lines in order and the total of one run', async () => {
    const mock = db({
      recurring_invoice_schedules: {
        data: [
          storedSchedule({
            items: [
              { line_type: 'product', description: 'Timmar', quantity: 1, unit: 'tim', unit_price: 50, vat_rate: 25, sort_order: 1 },
              { line_type: 'text', description: 'Avser {månad}', quantity: 0, unit: '', unit_price: 0, vat_rate: null, sort_order: 2 },
              { line_type: 'product', description: 'Support', quantity: 2, unit: 'st', unit_price: 100, vat_rate: null, sort_order: 0 },
            ],
          }),
          storedSchedule({ id: '44444444-4444-4444-8444-444444444444' }),
        ],
        count: 3,
      },
    })
    const res = await listSchedules(request(`${BASE}?status=active&limit=1&offset=1`, 'GET'), companyParams)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ count: 1, total_count: 3, has_more: true, next_offset: 2 })
    const [row] = data.schedules
    expect(row).toMatchObject({ recurring_schedule_id: SCHEDULE_ID, customer_name: 'Kunden AB', monthly_total_excl_vat: 250 })
    expect(row).not.toHaveProperty('id')
    expect(row.items.map((i: { description: string }) => i.description)).toEqual(['Support', 'Timmar', 'Avser {månad}'])
    expect(mock.calls).toContainEqual({ table: 'recurring_invoice_schedules', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(mock.calls).toContainEqual({ table: 'recurring_invoice_schedules', method: 'eq', args: ['status', 'active'] })
    expect(mock.calls).toContainEqual({ table: 'recurring_invoice_schedules', method: 'range', args: [1, 2] })
  })
})

describe('POST /api/v1/companies/:companyId/recurring-invoice-schedules', () => {
  const post = (body: unknown = CREATE_BODY, query = '') => createSchedule(request(`${BASE}${query}`, 'POST', body), companyParams)

  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    const mock = db()
    expect((await post()).status).toBe(403)
    expect(wroteSchedules(mock)).toBe(false)
  })

  it('400 on a schedule with no lines, a VAT rate outside the Swedish set or a key it does not take', async () => {
    const mock = db({ customers: { data: CUSTOMER } })
    for (const body of [
      { ...CREATE_BODY, items: [] },
      { ...CREATE_BODY, items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: 10 }] },
      { ...CREATE_BODY, company_id: 'other-company' },
    ]) {
      const res = await post(body)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
    expect(wroteSchedules(mock)).toBe(false)
  })

  it('404 CUSTOMER_NOT_FOUND for a customer outside the company', async () => {
    const mock = db({ customers: { data: null } })
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('CUSTOMER_NOT_FOUND')
    expect(mock.calls).toContainEqual({ table: 'customers', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wroteSchedules(mock)).toBe(false)
  })

  it('400 for auto_send to a customer without an email, naming the field', async () => {
    db({ customers: { data: { ...CUSTOMER, email: null } } })
    const res = await post({ ...CREATE_BODY, auto_send: true })
    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.details.field).toBe('auto_send')
  })

  it('the dry run previews the first run and what one run bills, and writes nothing', async () => {
    const mock = db({ customers: { data: CUSTOMER } })
    const res = await post({ ...CREATE_BODY, start_date: '2999-03-25' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.dry_run).toBe(true)
    expect(data.preview).toMatchObject({
      customer_name: 'Kunden AB',
      auto_send: false,
      interval_months: 1,
      projected_first_run_date: '2999-03-25',
      monthly_total_excl_vat: 5000,
    })
    expect(wroteSchedules(mock)).toBe(false)
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('creates the schedule and its lines in the company: 201', async () => {
    const mock = db({
      customers: { data: CUSTOMER },
      recurring_invoice_schedules: { data: { id: SCHEDULE_ID } },
      recurring_invoice_schedule_items: { data: null },
    })
    const res = await post({ ...CREATE_BODY, start_date: '2999-03-25' })
    expect(res.status).toBe(201)
    expect((await res.json()).data).toMatchObject({
      recurring_schedule_id: SCHEDULE_ID,
      status: 'active',
      next_run_date: '2999-03-25',
      item_count: 1,
      auto_send: false,
    })
    const [header] = mock.payloads('recurring_invoice_schedules', 'insert') as Array<Record<string, unknown>>
    expect(header).toMatchObject({ company_id: COMPANY_ID, user_id: 'user-1', customer_id: CUSTOMER_ID, status: 'active' })
    const [lines] = mock.payloads('recurring_invoice_schedule_items', 'insert') as Array<Array<Record<string, unknown>>>
    expect(lines).toEqual([expect.objectContaining({ schedule_id: SCHEDULE_ID, description: 'Support {månad}', sort_order: 0 })])
  })

  it('?stage=true proposes the schedule for a person to approve: 202, nothing created', async () => {
    const mock = db({ customers: { data: CUSTOMER } })
    const res = await post({ ...CREATE_BODY, auto_send: true }, '?stage=true')
    expect(res.status).toBe(202)
    expect((await res.json()).data).toMatchObject({ pending_operation_id: PENDING_ID, status: 'pending' })
    const [staged] = mock.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
    expect(staged).toMatchObject({
      company_id: COMPANY_ID,
      operation_type: 'create_recurring_schedule',
      title: 'Nytt återkommande fakturaschema: Månadsavgift',
      // A schedule that emails every invoice by itself is the approval's high risk.
      risk_level: 'high',
      params: expect.objectContaining({ customer_id: CUSTOMER_ID, auto_send: true, interval_months: 1 }),
    })
    expect(wroteSchedules(mock)).toBe(false)
  })
})

describe('PATCH /api/v1/companies/:companyId/recurring-invoice-schedules/:id', () => {
  const patch = (body: unknown, query = '', id = SCHEDULE_ID) =>
    updateSchedule(request(`${BASE}/${id}${query}`, 'PATCH', body), scheduleParams(id))

  it('400 on a change that names no field, and on a path id that is not a uuid', async () => {
    const mock = db()
    expect((await patch({})).status).toBe(400)
    expect((await patch({ status: 'paused' }, '', 'nope')).status).toBe(400)
    expect(wroteSchedules(mock)).toBe(false)
  })

  it('404 RECURRING_SCHEDULE_NOT_FOUND for a schedule the company does not hold', async () => {
    const mock = db({ recurring_invoice_schedules: { data: null } })
    const res = await patch({ status: 'paused' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('RECURRING_SCHEDULE_NOT_FOUND')
    expect(mock.calls).toContainEqual({ table: 'recurring_invoice_schedules', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wroteSchedules(mock)).toBe(false)
  })

  it('400 for a next_run_date that is not after today, naming the field', async () => {
    db({ recurring_invoice_schedules: { data: storedSchedule() } })
    const res = await patch({ next_run_date: '2020-01-25' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.field).toBe('next_run_date')
  })

  it('the dry run shows the schedule as it is, the change and as it would be, and writes nothing', async () => {
    const mock = db({ recurring_invoice_schedules: { data: storedSchedule() } })
    const res = await patch({ status: 'paused' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.preview).toMatchObject({
      current: { recurring_schedule_id: SCHEDULE_ID, status: 'active' },
      changes: { status: 'paused' },
      proposed: { status: 'paused', name: 'Månadsavgift' },
    })
    expect(wroteSchedules(mock)).toBe(false)
  })

  it('pauses the schedule in the company, leaving next_run_date alone', async () => {
    const mock = db({ recurring_invoice_schedules: [{ data: storedSchedule() }, { data: { updated_at: '2026-11-27T10:00:00Z' } }] })
    const res = await patch({ status: 'paused' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      recurring_schedule_id: SCHEDULE_ID,
      status: 'paused',
      updated_fields: ['status'],
      items_replaced: false,
    })
    expect(mock.payloads('recurring_invoice_schedules', 'update')).toEqual([{ status: 'paused' }])
  })

  it('?stage=true proposes the change: 202 with flat params, nothing written', async () => {
    const mock = db({ recurring_invoice_schedules: { data: storedSchedule() } })
    const res = await patch({ auto_send: true }, '?stage=true')
    expect(res.status).toBe(202)
    const [staged] = mock.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
    expect(staged).toMatchObject({
      operation_type: 'update_recurring_schedule',
      title: 'Uppdatera återkommande fakturaschema: Månadsavgift',
      risk_level: 'high',
      params: { schedule_id: SCHEDULE_ID, auto_send: true },
    })
    expect(wroteSchedules(mock)).toBe(false)
  })
})
