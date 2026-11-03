import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import { timeEntriesInvoice } from '@/lib/operations/time-entries'
import { buildTimeInvoiceLines } from '../invoice'
import type { TimeEntry } from '../types'

const buildStagedInvoice = vi.fn()
const createInvoiceFromStagedParams = vi.fn()
vi.mock('@/lib/pending-operations/build-staged-invoice', () => ({
  buildStagedInvoice: (...args: unknown[]) => buildStagedInvoice(...args),
  describeInvoiceBuildRefusal: (code: string) => code,
}))
vi.mock('@/lib/pending-operations/create-invoice-commit', () => ({
  createInvoiceFromStagedParams: (...args: unknown[]) => createInvoiceFromStagedParams(...args),
}))

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const INVOICE_ID = '99999999-9999-4999-8999-999999999999'
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const settings = {
  consultants: [],
  activity_codes: [
    { code: '1', name: 'Löpande bokföring', hourly_rate: 950 },
    { code: '2', name: 'Bokslut', hourly_rate: 1200 },
  ],
  customer_links: [],
  default_hourly_rate: null,
}

const entry = (overrides: Partial<TimeEntry> = {}): TimeEntry & { customers: null } => ({
  id: ID_A,
  company_id: 'company-1',
  user_id: 'user-1',
  entry_date: '2026-10-14',
  consultant: 'AB',
  customer_id: CUSTOMER_ID,
  customer_code: null,
  customer_name: 'Galärbryggan AB',
  project_code: null,
  activity_code: '1',
  hours: 2,
  comment: null,
  is_billable: true,
  invoice_id: null,
  source: 'manual',
  import_key: null,
  created_at: '2026-10-14T15:00:00Z',
  updated_at: '2026-10-14T15:00:00Z',
  customers: null,
  ...overrides,
})

describe('buildTimeInvoiceLines', () => {
  it('groups by activity, project and rate with the period, in a stable order', () => {
    const lines = buildTimeInvoiceLines(
      [
        entry({ entry_date: '2026-10-02', hours: 2 }),
        entry({ entry_date: '2026-10-20', hours: 1.5 }),
        entry({ activity_code: '2', project_code: 'P12', hours: 3 }),
      ],
      settings,
      'activity',
    )
    expect(lines).toEqual([
      { description: 'Bokslut, projekt P12, 2026-10-14', quantity: 3, unit: 'tim', unit_price: 1200, dimensions: { '6': 'P12' } },
      { description: 'Löpande bokföring, 2026-10-02 till 2026-10-20', quantity: 3.5, unit: 'tim', unit_price: 950 },
    ])
  })

  it('gives one dated line per entry, with the comment when there is one', () => {
    const lines = buildTimeInvoiceLines(
      [entry({ id: ID_B, entry_date: '2026-10-15', comment: 'Momsavstämning' }), entry({ entry_date: '2026-10-14' })],
      settings,
      'entry',
    )
    expect(lines.map((l) => l.description)).toEqual(['2026-10-14 AB: Löpande bokföring', '2026-10-15 AB: Momsavstämning'])
  })
})

let mock: ReturnType<typeof createQueuedMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  ctx = {
    supabase: mock.supabase as unknown as OperationContext['supabase'],
    companyId: 'company-1',
    userId: 'user-1',
    log: { error: () => {}, warn: () => {}, info: () => {} } as unknown as OperationContext['log'],
  }
  buildStagedInvoice.mockResolvedValue({
    ok: true,
    isQuote: false,
    params: {},
    build: { invoiceFields: { subtotal: 3800, vat_amount: 950, total: 4750 }, items: [], warnings: [] },
  })
})

const customer = { id: CUSTOMER_ID, name: 'Galärbryggan AB', default_payment_terms: 20 }
const input = (extra: Record<string, unknown> = {}) =>
  timeEntriesInvoice.input.parse({ customer_id: CUSTOMER_ID, invoice_date: '2026-11-03', ...extra })

describe('time-entries.invoice', () => {
  it('previews the draft built by the shared invoice build, due on the customer\'s terms', async () => {
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry({ hours: 2 }), entry({ id: ID_B, hours: 2 })] })
    mock.enqueue({ data: { value: settings } })
    const outcome = await timeEntriesInvoice.run(ctx, input({ from: '2026-10-01', to: '2026-10-31' }), { dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a preview')
    expect(outcome.preview).toMatchObject({
      customer_name: 'Galärbryggan AB',
      due_date: '2026-11-23',
      hours: 4,
      subtotal: 3800,
      total: 4750,
      entry_count: 2,
      time_entry_ids: [ID_A, ID_B],
      lines: [{ description: 'Löpande bokföring, 2026-10-14', hours: 4, hourly_rate: 950, amount: 3800 }],
    })
    const params = buildStagedInvoice.mock.calls[0][0].params
    expect(params).toMatchObject({ customer_id: CUSTOMER_ID, invoice_date: '2026-11-03', due_date: '2026-11-23' })
    expect(params.items[0]).toMatchObject({ line_type: 'product', quantity: 4, unit_price: 950 })
    expect(createInvoiceFromStagedParams).not.toHaveBeenCalled()

    // Staging pins the rows and the totals the approver saw.
    const pinned = timeEntriesInvoice.mcp!.stage!.pinParams!(input() as Record<string, unknown>, outcome.preview)
    expect(pinned).toMatchObject({ time_entry_ids: [ID_A, ID_B], expected_hours: 4, expected_subtotal: 3800, due_date: '2026-11-23' })
    expect(timeEntriesInvoice.input.safeParse(pinned).success).toBe(true)
  })

  it('refuses when there is nothing to invoice', async () => {
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [] })
    expect(await timeEntriesInvoice.run(ctx, input(), { dryRun: true })).toMatchObject({
      ok: false,
      code: 'TIME_INVOICE_NOTHING_TO_INVOICE',
    })
  })

  it('refuses hours without a rate instead of invoicing them at zero', async () => {
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry({ activity_code: '9' })] })
    mock.enqueue({ data: { value: settings } })
    expect(await timeEntriesInvoice.run(ctx, input(), { dryRun: true })).toMatchObject({
      ok: false,
      code: 'TIME_INVOICE_RATE_MISSING',
      details: { entries: 1, activity_codes: ['9'] },
    })
  })

  it('refuses a customer of another company', async () => {
    mock.enqueue({ data: null })
    expect(await timeEntriesInvoice.run(ctx, input(), { dryRun: true })).toMatchObject({
      ok: false,
      code: 'TIME_ENTRY_CUSTOMER_NOT_FOUND',
    })
  })

  it('refuses at commit when a pinned entry was invoiced or edited since the preview, before any invoice exists', async () => {
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry(), entry({ id: ID_B, invoice_id: INVOICE_ID })] })
    const outcome = await timeEntriesInvoice.run(
      ctx,
      input({ time_entry_ids: [ID_A, ID_B], expected_hours: 4, expected_subtotal: 3800 }),
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'TIME_INVOICE_ENTRIES_CHANGED' })
    expect(createInvoiceFromStagedParams).not.toHaveBeenCalled()

    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry(), entry({ id: ID_B, hours: 3 })] })
    mock.enqueue({ data: { value: settings } })
    const changedHours = await timeEntriesInvoice.run(
      ctx,
      input({ time_entry_ids: [ID_A, ID_B], expected_hours: 4, expected_subtotal: 3800 }),
      { dryRun: false },
    )
    expect(changedHours).toMatchObject({ ok: false, code: 'TIME_INVOICE_ENTRIES_CHANGED', details: { expected_hours: 4, hours: 5 } })
    expect(createInvoiceFromStagedParams).not.toHaveBeenCalled()
  })

  it('creates the draft through the shared write and links exactly the pinned entries', async () => {
    createInvoiceFromStagedParams.mockResolvedValue({ data: { invoice_id: INVOICE_ID, invoice_number: null } })
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry(), entry({ id: ID_B })] })
    mock.enqueue({ data: { value: settings } })
    mock.enqueue({ data: [{ id: ID_A }, { id: ID_B }] })
    const outcome = await timeEntriesInvoice.run(
      ctx,
      input({ time_entry_ids: [ID_A, ID_B], expected_hours: 4, expected_subtotal: 3800, due_date: '2026-11-23' }),
      { dryRun: false },
    )
    expect(outcome).toEqual({
      ok: true,
      created: true,
      data: { invoice_id: INVOICE_ID, entry_count: 2, hours: 4, subtotal: 3800 },
    })
    expect(createInvoiceFromStagedParams).toHaveBeenCalledWith(ctx.supabase, 'user-1', 'company-1', expect.objectContaining({ customer_id: CUSTOMER_ID }))
    expect(mock.findCall('time_entries', 'update')).toEqual([{ invoice_id: INVOICE_ID }])
    expect(mock.findCall('time_entries', 'in')).toEqual(['id', [ID_A, ID_B]])
    expect(mock.findCalls('time_entries', 'is')).toContainEqual(['invoice_id', null])
  })

  it('names the created draft as a partial result when not every entry could be linked', async () => {
    createInvoiceFromStagedParams.mockResolvedValue({ data: { invoice_id: INVOICE_ID } })
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry(), entry({ id: ID_B })] })
    mock.enqueue({ data: { value: settings } })
    mock.enqueue({ data: [{ id: ID_A }] })
    const outcome = await timeEntriesInvoice.run(
      ctx,
      input({ time_entry_ids: [ID_A, ID_B], expected_hours: 4, expected_subtotal: 3800, due_date: '2026-11-23' }),
      { dryRun: false },
    )
    expect(outcome).toMatchObject({
      ok: false,
      code: 'TIME_INVOICE_ENTRIES_CHANGED',
      partialPostedIds: { invoice_id: INVOICE_ID },
      details: { linked: 1, expected: 2 },
    })
  })

  it('passes an invoice build refusal through with its code', async () => {
    buildStagedInvoice.mockResolvedValue({ ok: false, code: 'INVOICE_CREATE_VAT_RULE_VIOLATION', details: {} })
    mock.enqueue({ data: customer })
    mock.enqueue({ data: [entry()] })
    mock.enqueue({ data: { value: settings } })
    expect(await timeEntriesInvoice.run(ctx, input({ due_date: '2026-11-30' }), { dryRun: true })).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
    })
  })
})
