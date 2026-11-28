import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const payoutUpsert = vi.fn()
const payoutRefresh = vi.fn()
const payoutDelete = vi.fn()
const refreshFilters: unknown[][] = []
const deleteFilters: unknown[][] = []
const serviceClient = {
  marker: 'service',
  from: (table: string) => {
    if (table !== 'webshop_payouts') throw new Error(`unexpected service table ${table}`)
    return {
      upsert: (...args: unknown[]) => payoutUpsert(...args),
      delete: () => {
        payoutDelete()
        const chain = {
          eq: (...args: unknown[]) => (deleteFilters.push(['eq', ...args]), chain),
          is: (...args: unknown[]) => (deleteFilters.push(['is', ...args]), chain),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        }
        return chain
      },
      update: (patch: unknown) => {
        payoutRefresh(patch)
        const chain = {
          eq: (...args: unknown[]) => (refreshFilters.push(['eq', ...args]), chain),
          is: (...args: unknown[]) => (refreshFilters.push(['is', ...args]), chain),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        }
        return chain
      },
    }
  },
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
  createServiceClient: () => serviceClient,
}))

const upsertMock = vi.fn()
vi.mock('@/lib/webshop-orders/ingest', () => ({
  upsertWebshopOrders: (...args: unknown[]) => upsertMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const REPORT = [
  'total_sale_amount;total_fee_amount;total_return_amount;total_settlement_amount;total_tax_amount;payment_reference;settlement_currency;payout_date;merchant_id',
  '1250.00;12.50;300.00;934.37;3.13;PAY123;SEK;2026-11-19T00:00:00.000Z;M100',
  'type;capture_date;sale_date;order_id;short_order_id;capture_id;merchant_reference1;amount;posting_currency;refund_id;purchase_country;tax_rate_1;tax_amount_1',
  'SALE;2026-11-18T09:00:00.000Z;2026-11-17T20:00:00.000Z;order-a;AAAA-1;cap-1;REFA;1250.00;SEK;;SE;2500;250.00',
  'FEE;2026-11-18T09:00:00.000Z;2026-11-17T20:00:00.000Z;order-a;AAAA-1;cap-1;REFA;12.50;SEK;;SE;;',
  'RETURN;2026-11-18T07:00:00.000Z;2026-10-02T10:00:00.000Z;order-c;CCCC;;REFC;300.00;SEK;ref-1;SE;2500;60.00',
].join('\n')

function makeFileRequest(content: string | null, filename = 'Settlement_Report_PAY123.csv') {
  const formData = new FormData()
  if (content !== null) formData.append('file', new File([content], filename, { type: 'text/csv' }))
  return new Request('http://localhost:3000/api/webshop-orders/kustom-settlement', {
    method: 'POST',
    body: formData,
  })
}

async function jsonOf(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe('POST /api/webshop-orders/kustom-settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    upsertMock.mockResolvedValue({ inserted: 2, updated: 0, unchanged: 0, frozenFlagged: 0, crossMarked: 0, errors: 0 })
    payoutUpsert.mockResolvedValue({ error: null })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeFileRequest(REPORT), emptyParams)
    expect(response.status).toBe(401)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('refuses a member who may not write', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const response = await POST(makeFileRequest(REPORT), emptyParams)
    expect(response.status).toBe(403)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('returns 400 when no file is attached', async () => {
    const { status, body } = await jsonOf(await POST(makeFileRequest(null), emptyParams))
    expect(status).toBe(400)
    expect(body.error.code).toBe('KUSTOM_SETTLEMENT_NO_FILE')
  })

  it('returns 400 for a file that is not a Kustom settlement report', async () => {
    const { status, body } = await jsonOf(
      await POST(makeFileRequest('Datum;Text;Belopp\n2026-11-18;Insättning;100,00', 'bank.csv'), emptyParams),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('KUSTOM_SETTLEMENT_NOT_RECOGNIZED')
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('returns 400 and says how to fix it when the report has no consumer VAT', async () => {
    const withoutVat = REPORT.replace(';tax_rate_1;tax_amount_1', '')
    const { status, body } = await jsonOf(await POST(makeFileRequest(withoutVat), emptyParams))
    expect(status).toBe(400)
    expect(body.error.code).toBe('KUSTOM_SETTLEMENT_NO_CONSUMER_VAT')
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('writes the sales and returns to the Orders page for the active company and answers with the payout', async () => {
    enqueue({ data: [] }) // the shop feeds have none of these orders
    const { status, body } = await jsonOf(await POST(makeFileRequest(REPORT), emptyParams))
    expect(status).toBe(200)

    expect(upsertMock).toHaveBeenCalledTimes(1)
    const [client, companyId, userId, rows] = upsertMock.mock.calls[0] as [unknown, string, string, WebshopOrderUpsert[]]
    expect(client).toBe(serviceClient)
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect(rows.map((r) => [r.platform, r.row_type, r.total, r.paid_date, r.is_paid])).toEqual([
      ['kustom', 'order', 1250, '2026-11-18', true],
      ['kustom', 'refund', -300, '2026-11-18', true],
    ])
    // The shop feeds were asked about these order numbers, in this company.
    expect(findCalls('webshop_orders', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('webshop_orders', 'in')).toEqual([
      ['platform', ['woocommerce', 'shopify']],
      ['order_number', ['REFA', 'REFC']],
    ])

    expect(body.data).toEqual({
      payout: {
        reference: 'PAY123',
        merchantId: 'M100',
        payoutDate: '2026-11-19',
        currency: 'SEK',
        sales: 1250,
        returns: 300,
        reversals: 0,
        fees: 12.5,
        feeVat: 3.13,
        holdback: 0,
        release: 0,
        other: 0,
        settlement: 934.37,
      },
      sales: 1,
      refunds: 1,
      inserted: 2,
      updated: 0,
      unchanged: 0,
      frozen_flagged: 0,
      sales_held: 0,
      returns_held: 0,
      returns_left_out: { count: 0, total: 0 },
      payout_recorded: true,
    })

    // The payout is stored once, its parts signed toward it and adding up to
    // what Kustom paid out, so its bank row can be proposed.
    expect(payoutUpsert).toHaveBeenCalledTimes(1)
    const [record, options] = payoutUpsert.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>]
    expect(record).toEqual({
      platform: 'kustom',
      store_scope: 'M100',
      external_id: 'kustom_M100_payout_PAY123',
      reference: 'PAY123',
      payout_date: '2026-11-19',
      currency: 'SEK',
      amount: 934.37,
      lines: [
        { kind: 'sale', amount: 1250 },
        { kind: 'return', amount: -300 },
        { kind: 'fee', amount: -12.5 },
        { kind: 'fee_vat', amount: -3.13 },
      ],
      company_id: 'company-1',
      user_id: 'user-1',
    })
    expect(options).toEqual({ onConflict: 'company_id,external_id', ignoreDuplicates: true })
    // A payout no bank row has claimed takes the report's figures again.
    expect(payoutRefresh).toHaveBeenCalledWith(expect.objectContaining({ amount: 934.37 }))
    expect(refreshFilters).toEqual(
      expect.arrayContaining([
        ['eq', 'external_id', 'kustom_M100_payout_PAY123'],
        ['is', 'transaction_id', null],
        ['is', 'journal_entry_id', null],
      ]),
    )
  })

  it('withdraws the unclaimed payout a corrected report says never reached the bank', async () => {
    enqueue({ data: [] })
    deleteFilters.length = 0
    const corrected = REPORT.replace(';PAY123;SEK;2026-11-19T00:00:00.000Z;M100', ';PAY123;SEK;;M100')
    const { status, body } = await jsonOf(await POST(makeFileRequest(corrected), emptyParams))
    expect(status).toBe(200)
    expect(body.data.payout_recorded).toBe(false)
    expect(payoutUpsert).not.toHaveBeenCalled()
    expect(payoutDelete).toHaveBeenCalledTimes(1)
    expect(deleteFilters).toEqual(
      expect.arrayContaining([
        ['eq', 'external_id', 'kustom_M100_payout_PAY123'],
        ['is', 'transaction_id', null],
        ['is', 'journal_entry_id', null],
      ]),
    )
  })

  it('returns 500 when the payout could not be stored, so the user reads the file again', async () => {
    enqueue({ data: [] })
    payoutUpsert.mockResolvedValue({ error: { message: 'boom' } })
    const { status, body } = await jsonOf(await POST(makeFileRequest(REPORT), emptyParams))
    expect(status).toBe(500)
    expect(body.error.code).toBe('KUSTOM_SETTLEMENT_IMPORT_FAILED')
  })

  it('holds a sale the shop feed already has, and leaves its return out, so nothing is booked twice', async () => {
    enqueue({ data: [{ order_number: 'REFA' }, { order_number: 'REFC' }] })
    const { status, body } = await jsonOf(await POST(makeFileRequest(REPORT), emptyParams))
    expect(status).toBe(200)
    const rows = upsertMock.mock.calls[0][3] as WebshopOrderUpsert[]
    expect(rows.map((r) => [r.order_number, r.is_paid, r.status])).toEqual([['REFA', false, 'needs_review']])
    expect(body.data).toMatchObject({ sales_held: 1, returns_left_out: { count: 1, total: 300 } })
  })

  it('returns 500 and writes nothing when the shop feeds cannot be asked', async () => {
    enqueue({ error: { message: 'timeout' } })
    const { status, body } = await jsonOf(await POST(makeFileRequest(REPORT), emptyParams))
    expect(status).toBe(500)
    expect(body.error.code).toBe('KUSTOM_SETTLEMENT_IMPORT_FAILED')
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('returns 500 when rows could not be saved, so the user reads the file again', async () => {
    upsertMock.mockResolvedValue({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      frozenFlagged: 0,
      crossMarked: 0,
      errors: 1,
      firstError: { message: 'boom' },
    })
    const { status, body } = await jsonOf(await POST(makeFileRequest(REPORT), emptyParams))
    expect(status).toBe(500)
    expect(body.error.code).toBe('KUSTOM_SETTLEMENT_IMPORT_FAILED')
  })
})
