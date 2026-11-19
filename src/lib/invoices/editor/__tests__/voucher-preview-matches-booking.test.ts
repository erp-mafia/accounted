import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
}))
// The month check reads fiscal periods and the lock date; the voucher is the subject here.
vi.mock('@/lib/bookkeeping/accruals/accrued-cost-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/accruals/accrued-cost-guard')>()),
  assertAccruedIncomeLinesBookable: vi.fn().mockResolvedValue(undefined),
}))

import { CreateInvoiceSchema } from '@/lib/api/schemas'
import { buildInvoiceJournalEntryInput } from '@/lib/bookkeeping/invoice-entries'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { buildInvoiceWritePayload } from '@/lib/invoices/editor-payload'
import { proposeDraftSendLines, type DraftVoucherItem } from '@/lib/invoices/editor/voucher-preview'
import { roundOre } from '@/lib/money'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Invoice, InvoiceItem } from '@/types'

// #114: the editor's send confirm previewed the verifikat from a hand-picked
// subset of each form row, so a periodiserad line showed 3001 where the send
// credits 1790 or 2970, and an own account or a dimension bag was dropped.
// The counterpart of src/lib/supplier-invoices/__tests__/
// review-preview-matches-booking.test.ts (crm#1190): the editor's rows go
// through the write path the send stores them with and the builder the send
// books with, and the preview must show that verifikat row for row.

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INVOICE_DATE = '2026-10-26'

/** A row as the editor holds it (appendProductRow's defaults). */
function formRow(overrides: Partial<DraftVoucherItem> & { description?: string }) {
  return {
    line_type: 'product' as const,
    description: 'Konsulttid',
    quantity: 1,
    unit: 'st',
    unit_price: 100000,
    discount_percent: null,
    vat_rate: 25,
    article_id: null,
    sales_order_item_id: null,
    revenue_account: null,
    deduction_type: null,
    labor_hours: null,
    work_type: null,
    housing_designation: null,
    apartment_number: null,
    brf_org_number: null,
    accrual_period_start: null,
    accrual_period_end: null,
    accrual_balance_account: null,
    dimensions: null,
    ...overrides,
  }
}

type Row = [account: string, debit: number, credit: number, dimensions: Record<string, string> | undefined]

/** The verifikat the send books for these form rows. */
async function bookedRows(items: ReturnType<typeof formRow>[], defaultDims: Record<string, string>): Promise<Row[]> {
  const body = buildInvoiceWritePayload(
    {
      customer_id: CUSTOMER_ID,
      invoice_date: INVOICE_DATE,
      due_date: '2026-11-25',
      currency: 'SEK',
      document_type: 'invoice',
      items,
    },
    { oreRounding: false, defaultDims },
  )
  const input = CreateInvoiceSchema.parse(JSON.parse(JSON.stringify(body)))
  const { supabase } = createTableMockSupabase({
    company_settings: { data: { vat_registered: true, accounting_method: 'accrual' } },
    chart_of_accounts: { data: [{ account_number: '3041' }] },
  })
  const build = await buildInvoiceWriteData({
    supabase: supabase as never,
    companyId: COMPANY_ID,
    customer: {
      id: CUSTOMER_ID,
      customer_type: 'swedish_business',
      vat_number: 'SE556677889901',
      vat_number_validated: true,
      personal_number: null,
      country: 'SE',
    },
    documentType: 'invoice',
    input: input as never,
  })
  if (!build.ok) throw new Error(`write refused: ${JSON.stringify(build)}`)
  const invoice = {
    ...build.invoiceFields,
    id: 'invoice-1',
    invoice_number: '1043',
    items: build.items.map((row, i) => ({ ...row, id: `item-${i}`, invoice_id: 'invoice-1' })) as unknown as InvoiceItem[],
  } as unknown as Invoice
  const entry = await buildInvoiceJournalEntryInput(null as never, COMPANY_ID, invoice, 'aktiebolag')
  if (!entry) throw new Error('no entry')
  return entry.lines
    .filter((l) => roundOre(l.debit_amount) !== 0 || roundOre(l.credit_amount) !== 0)
    .map((l) => [
      l.account_number,
      roundOre(l.debit_amount),
      roundOre(l.credit_amount),
      l.dimensions && Object.keys(l.dimensions).length > 0 ? l.dimensions : undefined,
    ])
}

/** The verifikat the editor's confirm shows for the same rows. */
function previewRows(items: ReturnType<typeof formRow>[], defaultDims: Record<string, string>): Row[] {
  return proposeDraftSendLines({
    invoiceNumber: '1043',
    invoiceDate: INVOICE_DATE,
    currency: 'SEK',
    vatTreatment: 'standard_25',
    vatRegistered: true,
    defaultVatRate: 25,
    items,
    defaultDimensions: defaultDims,
    entityType: 'aktiebolag',
  }).map((l) => [l.account_number, Number(l.debit_amount || 0), Number(l.credit_amount || 0), l.dimensions])
}

beforeEach(() => vi.clearAllMocks())

describe('the editor confirm previews the verifikat the send books (#114)', () => {
  it('the reported F005: September on a 2026-10-26 invoice credits 1790', async () => {
    const items = [
      formRow({ accrual_period_start: '2026-09-01', accrual_period_end: '2026-09-30', accrual_balance_account: '1790' }),
    ]
    const booked = await bookedRows(items, {})
    expect(booked).toEqual([
      ['1510', 125000, 0, undefined],
      ['1790', 0, 100000, undefined],
      ['2611', 0, 25000, undefined],
    ])
    expect(previewRows(items, {})).toEqual(booked)
  })

  it('a 29xx line, a 17xx line, an own account, a dimension bag and a plain row on one invoice', async () => {
    const items = [
      formRow({ accrual_period_start: '2026-11-01', accrual_period_end: '2027-01-31', accrual_balance_account: '2970' }),
      formRow({
        unit_price: 30000,
        accrual_period_start: '2026-08-01',
        accrual_period_end: '2026-09-30',
        accrual_balance_account: '1790',
        dimensions: { '1': 'KS1' },
      }),
      formRow({ unit_price: 1200, revenue_account: '3041' }),
      formRow({ unit_price: 499.5, vat_rate: 12, dimensions: { '6': 'P2' } }),
      formRow({ unit_price: 800, discount_percent: 12.5 }),
    ]
    const defaultDims = { '6': 'P1' }
    const booked = await bookedRows(items, defaultDims)
    expect(booked.map((row) => row[0])).toEqual(['1510', '2970', '1790', '3041', '3001', '2611', '3002', '2621'])
    expect(previewRows(items, defaultDims)).toEqual(booked)
  })
})
