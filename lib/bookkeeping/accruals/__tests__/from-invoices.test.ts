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
import { createAccrualSchedule } from '@/lib/bookkeeping/accruals/service'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccrualSchedule, InvoiceItem, SupplierInvoiceItem } from '@/types'

vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  createAccrualSchedule: vi.fn(),
}))

const mockCreateAccrualSchedule = vi.mocked(createAccrualSchedule)

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

    expect(result).toEqual({ created: 1, failed: 0 })
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

    expect(result).toEqual({ created: 1, failed: 0 })
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
})
