/**
 * Periodisering over one calendar month: an October invoice whose cost (or
 * revenue) belongs to November only. The schedule carries one installment of
 * the whole amount, released on 1 November; a period lying only in the
 * invoice month is the one shape that moves nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  accrualCoversOnlyInvoiceMonth,
  computeInstallments,
  invoiceMonthOnlyAccrualRows,
} from '@/lib/bookkeeping/accruals/compute'
import { createAccrualSchedule, postDueInstallments } from '@/lib/bookkeeping/accruals/service'
import { commitAccrualInstallment, createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'

vi.mock('@/lib/bookkeeping/engine', () => ({
  cancelDraftEntry: vi.fn(),
  commitAccrualInstallment: vi.fn(),
  createDraftEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  reverseEntry: vi.fn(),
}))

// A month posts as a draft committed together with its own row.
const mockCreateDraftEntry = vi.mocked(createDraftEntry)
const mockCommitAccrualInstallment = vi.mocked(commitAccrualInstallment)
const mockFindFiscalPeriod = vi.mocked(findFiscalPeriod)

const COMPANY = 'company-1'
const USER = 'user-1'

const novemberOnlySchedule = {
  id: 'sched-nov',
  user_id: USER,
  company_id: COMPANY,
  direction: 'expense',
  supplier_invoice_id: 'si-1',
  supplier_invoice_item_id: 'sii-1',
  invoice_id: null,
  invoice_item_id: null,
  balance_account: '1790',
  target_account: '5010',
  total_amount: 5000,
  period_start: '2026-11-01',
  period_end: '2026-11-30',
  months: 1,
  origin_journal_entry_id: 'je-origin',
  // The registration verifikat is dated on the October invoice date.
  posting_floor_date: '2026-10-15',
  status: 'active',
  description: 'Lokalhyra november',
  dimensions: {},
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindFiscalPeriod.mockResolvedValue('fp-2026')
  mockCreateDraftEntry.mockResolvedValue({ id: 'je-release' } as never)
  mockCommitAccrualInstallment.mockResolvedValue({ outcome: 'posted', entry: { id: 'je-release' } } as never)
})

describe('accrualCoversOnlyInvoiceMonth', () => {
  it('is true only when the whole period lies in the invoice month', () => {
    expect(accrualCoversOnlyInvoiceMonth('2026-10-15', '2026-10-01', '2026-10-31')).toBe(true)
    expect(accrualCoversOnlyInvoiceMonth('2026-10-15', '2026-10-15', '2026-10-20')).toBe(true)
    // November only on an October invoice: the case periodisering exists for.
    expect(accrualCoversOnlyInvoiceMonth('2026-10-15', '2026-11-01', '2026-11-30')).toBe(false)
    // Reaching into the next month by a day still defers half.
    expect(accrualCoversOnlyInvoiceMonth('2026-10-15', '2026-10-31', '2026-11-30')).toBe(false)
    // Same month number, another year.
    expect(accrualCoversOnlyInvoiceMonth('2026-10-15', '2027-10-01', '2027-10-31')).toBe(false)
  })

  it('names the 0-based rows at fault and skips rows without a full period', () => {
    expect(
      invoiceMonthOnlyAccrualRows('2026-10-15', [
        { accrual_period_start: '2026-11-01', accrual_period_end: '2026-11-30' },
        {},
        { accrual_period_start: '2026-10-01', accrual_period_end: '2026-10-31' },
        { accrual_period_start: '2026-10-01', accrual_period_end: null },
      ]),
    ).toEqual([2])
  })
})

describe('one-month periodisering on an October invoice', () => {
  it('plans a single installment of the whole amount for November', () => {
    expect(computeInstallments(5000, '2026-11-01', '2026-11-30')).toEqual([
      { period_month: '2026-11-01', amount: 5000 },
    ])
  })

  it('creates the schedule with one month and one installment', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: novemberOnlySchedule }, // schedule insert
      { data: null }, // installments insert
    ])

    await createAccrualSchedule(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      {
        direction: 'expense',
        supplierInvoiceId: 'si-1',
        supplierInvoiceItemId: 'sii-1',
        balanceAccount: '1790',
        targetAccount: '5010',
        totalAmountSek: 5000,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        description: 'Lokalhyra november',
      },
      { originJournalEntryId: 'je-origin', postingFloorDate: '2026-10-15', postCatchUp: false },
    )

    expect(findCall('accrual_schedules', 'insert')?.[0]).toMatchObject({
      months: 1,
      period_start: '2026-11-01',
      period_end: '2026-11-30',
      total_amount: 5000,
    })
    expect(findCall('accrual_schedule_installments', 'insert')?.[0]).toEqual([
      expect.objectContaining({ period_month: '2026-11-01', amount: 5000, status: 'pending' }),
    ])
  })

  it('releases the whole amount on 1 November: Dr cost / Cr 17xx', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          {
            id: 'inst-nov',
            user_id: USER,
            company_id: COMPANY,
            schedule_id: 'sched-nov',
            period_month: '2026-11-01',
            amount: 5000,
            status: 'pending',
            journal_entry_id: null,
            posted_at: null,
            last_error: null,
            schedule: novemberOnlySchedule,
          },
        ],
      }, // due installments
      { data: { bookkeeping_locked_through: null } }, // company lock date
      { count: 0 }, // nothing left pending
      { data: null }, // schedule -> completed
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-11-01',
    })

    expect(result).toMatchObject({ posted: 1, failed: 0 })
    const input = mockCreateDraftEntry.mock.calls[0][3]
    // The period month wins over the October posting floor.
    expect(input.entry_date).toBe('2026-11-01')
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '5010', debit_amount: 5000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1790', debit_amount: 0, credit_amount: 5000 }),
    ])
  })
})
