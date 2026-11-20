import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQueuedMockSupabase,
  makeInvoice,
  makeSupplierInvoice,
} from '@/tests/helpers'
import {
  createSchedulesForCustomerInvoice,
  createSchedulesForSupplierInvoice,
} from '@/lib/bookkeeping/accruals/from-invoices'
import { createAccrualSchedule, postDueInstallments } from '@/lib/bookkeeping/accruals/service'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccrualSchedule, InvoiceItem, SupplierInvoiceItem } from '@/types'

vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  createAccrualSchedule: vi.fn(),
  postDueInstallments: vi.fn(),
}))

const mockCreateAccrualSchedule = vi.mocked(createAccrualSchedule)
const mockPostDueInstallments = vi.mocked(postDueInstallments)

const COMPANY = 'company-1'
const USER = 'user-1'

function makeSupplierItem(
  overrides: Partial<SupplierInvoiceItem> = {},
): SupplierInvoiceItem {
  return {
    id: 'sii-1',
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Försäkring 2026',
    quantity: 1,
    unit: 'st',
    unit_price: 12000,
    line_total: 12000,
    account_number: '6310',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: 3000,
    reverse_charge_rate: null,
    accrual_period_start: '2026-01-01',
    accrual_period_end: '2026-12-31',
    accrual_balance_account: '1730',
    created_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function makeInvoiceItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'ii-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Serviceavtal 2026',
    quantity: 1,
    unit: 'st',
    unit_price: 12000,
    line_total: 12000,
    vat_rate: 25,
    vat_amount: 3000,
    accrual_period_start: '2026-01-01',
    accrual_period_end: '2026-12-31',
    accrual_balance_account: '2970',
    created_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateAccrualSchedule.mockResolvedValue({ id: 'sched-1' } as AccrualSchedule)
  mockPostDueInstallments.mockResolvedValue({ posted: 1, failed: 0, skipped: 0, errors: [] })
})

describe('createSchedulesForSupplierInvoice', () => {
  it('passes the invoice default merged with the item bag as the spec dimensions', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }]) // no existing schedules

    const invoice = makeSupplierInvoice({
      id: 'si-1',
      default_dimensions: { '1': 'KS01', '6': 'P000' },
    })
    const item = makeSupplierItem({ dimensions: { '6': 'P001' } })

    const result = await createSchedulesForSupplierInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      invoice,
      [item],
      'je-origin',
    )

    expect(result).toEqual({ created: 1, failed: 0, releasesFailed: 0 })
    // Item bag wins per key over the invoice default: identical merge to the
    // registration entry's interim 17xx line (groupExpenseBuckets).
    expect(mockCreateAccrualSchedule).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      expect.objectContaining({ dimensions: { '1': 'KS01', '6': 'P001' } }),
      expect.anything(),
    )
  })

  it('passes undefined dimensions when neither invoice nor item is tagged', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    await createSchedulesForSupplierInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeSupplierInvoice({ id: 'si-1' }),
      [makeSupplierItem()],
      'je-origin',
    )

    const spec = mockCreateAccrualSchedule.mock.calls[0][3]
    expect(spec.dimensions).toBeUndefined()
  })

  it('names the invoice by its supplier number in the schedule text', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    await createSchedulesForSupplierInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeSupplierInvoice({ id: 'si-1', supplier_invoice_number: 'LF-77', arrival_number: 9 }),
      [makeSupplierItem()],
      'je-origin',
    )

    expect(mockCreateAccrualSchedule.mock.calls[0][3].description).toBe('Försäkring 2026 (leverantörsfaktura LF-77)')
  })

  // crm#1039: never "(leverantörsfaktura null)" in a periodisering text.
  it('names a number-less invoice by its ankomstnummer', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    await createSchedulesForSupplierInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeSupplierInvoice({ id: 'si-1', supplier_invoice_number: null, arrival_number: 9 }),
      [makeSupplierItem()],
      'je-origin',
    )

    expect(mockCreateAccrualSchedule.mock.calls[0][3].description).toBe('Försäkring 2026 (leverantörsfaktura ankomstnr 9)')
  })

  it('creates an upplupen kostnad on 29xx and posts its months right after, counting failures', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])
    // Jul-Sep electricity on an October invoice: all three months are due
    // at once; one could not be posted.
    mockPostDueInstallments.mockResolvedValueOnce({
      posted: 2,
      failed: 1,
      skipped: 0,
      errors: [{ installmentId: 'inst-3', message: 'locked' }],
    })

    const result = await createSchedulesForSupplierInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeSupplierInvoice({ id: 'si-1', invoice_date: '2026-10-05' }),
      [
        makeSupplierItem({
          account_number: '5020',
          accrual_period_start: '2026-07-01',
          accrual_period_end: '2026-09-30',
          accrual_balance_account: '2990',
        }),
      ],
      'je-origin',
    )

    expect(result).toEqual({ created: 1, failed: 0, releasesFailed: 1 })
    expect(mockCreateAccrualSchedule).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      expect.objectContaining({ direction: 'expense', balanceAccount: '2990', targetAccount: '5020' }),
      // Catch-up runs here so its failures reach the door, not inside.
      expect.objectContaining({ postCatchUp: false, originJournalEntryId: 'je-origin' }),
    )
    expect(mockPostDueInstallments).toHaveBeenCalledWith(expect.anything(), COMPANY, {
      userId: USER,
      scheduleId: 'sched-1',
    })
  })

  it('counts a catch-up that throws as a failed release, never as a failed schedule', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])
    mockPostDueInstallments.mockRejectedValueOnce(new Error('connection reset'))

    const result = await createSchedulesForSupplierInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeSupplierInvoice({ id: 'si-1' }),
      [makeSupplierItem()],
      'je-origin',
    )

    expect(result).toEqual({ created: 1, failed: 0, releasesFailed: 1 })
  })
})

describe('createSchedulesForCustomerInvoice', () => {
  it('passes the invoice default merged with the item bag as the spec dimensions', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }]) // no existing schedules

    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      default_dimensions: { '1': 'KS01' },
    })
    const item = makeInvoiceItem({ dimensions: { '6': 'P001' } })

    const result = await createSchedulesForCustomerInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      invoice,
      [item],
      'je-origin',
    )

    expect(result).toEqual({ created: 1, failed: 0, releasesFailed: 0 })
    expect(mockCreateAccrualSchedule).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      expect.objectContaining({
        direction: 'revenue',
        dimensions: { '1': 'KS01', '6': 'P001' },
      }),
      expect.anything(),
    )
  })

  // Upplupen intäkt (17xx, #62): September consulting on an October invoice.
  // Every month lies before the invoice, so all of them post right after the
  // revenue entry, and a month that fails comes back to the door.
  it('creates a 17xx schedule floored at the invoice date and posts its months at once', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', invoice_date: '2026-10-15', invoice_number: '1043' })
    const item = makeInvoiceItem({
      description: 'Konsultation september',
      line_total: 30000,
      accrual_period_start: '2026-09-01',
      accrual_period_end: '2026-09-30',
      accrual_balance_account: '1790',
    })

    const result = await createSchedulesForCustomerInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      invoice,
      [item],
      'je-origin',
    )

    expect(result).toEqual({ created: 1, failed: 0, releasesFailed: 0 })
    expect(mockCreateAccrualSchedule).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      expect.objectContaining({
        direction: 'revenue',
        balanceAccount: '1790',
        totalAmountSek: 30000,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      }),
      { originJournalEntryId: 'je-origin', postingFloorDate: '2026-10-15', postCatchUp: false },
    )
    expect(mockPostDueInstallments).toHaveBeenCalledWith(expect.anything(), COMPANY, {
      userId: USER,
      scheduleId: 'sched-1',
    })
  })

  it('counts months that could not post as failed releases', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])
    mockPostDueInstallments.mockResolvedValueOnce({
      posted: 1,
      failed: 1,
      skipped: 0,
      errors: [{ installmentId: 'inst-1', message: 'locked' }],
    })

    const result = await createSchedulesForCustomerInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeInvoice({ id: 'inv-1', status: 'sent', invoice_date: '2026-10-15' }),
      [makeInvoiceItem({ accrual_period_start: '2026-08-01', accrual_period_end: '2026-09-30', accrual_balance_account: '1790' })],
      'je-origin',
    )

    expect(result).toEqual({ created: 1, failed: 0, releasesFailed: 1 })
  })

  it('never defers a reverse-charge line, whatever its interim account', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    const result = await createSchedulesForCustomerInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      makeInvoice({ id: 'inv-1', status: 'sent', invoice_date: '2026-10-15', vat_treatment: 'reverse_charge' }),
      [makeInvoiceItem({ vat_rate: 0, vat_amount: 0, accrual_period_start: '2026-09-01', accrual_period_end: '2026-09-30', accrual_balance_account: '1790' })],
      'je-origin',
    )

    expect(result).toEqual({ created: 0, failed: 0, releasesFailed: 0 })
    expect(mockCreateAccrualSchedule).not.toHaveBeenCalled()
    expect(mockPostDueInstallments).not.toHaveBeenCalled()
  })

  it('collapses a multi-line description to one line of voucher text', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1042' })
    const item = makeInvoiceItem({ description: 'Konsultation\nSeptember 2026' })

    await createSchedulesForCustomerInvoice(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      invoice,
      [item],
      'je-origin',
    )

    expect(mockCreateAccrualSchedule).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      expect.objectContaining({ description: 'Konsultation September 2026 (faktura 1042)' }),
      expect.anything(),
    )
  })
})
