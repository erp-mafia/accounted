/**
 * gnubok_create_invoice: the invoice's own payment QR code (qr_mode). The
 * tool stages it for approval (the executor writes it, see
 * create-invoice-executor.test.ts); omitted or null inherits the company's
 * invoice_qr_mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!

const CUSTOMER = {
  id: 'cust-1',
  name: 'Acme AB',
  customer_type: 'swedish_business',
  vat_number_validated: false,
  default_payment_terms: 30,
}

const ITEMS = [{ description: 'Konsulttimme', quantity: 1, unit: 'tim', unit_price: 1000 }]

beforeEach(() => {
  vi.clearAllMocks()
})

async function stage(args: Record<string, unknown>) {
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  enqueue({ data: CUSTOMER, error: null }) // customers fetch
  enqueue({ data: { vat_registered: true }, error: null }) // buildStagedInvoice: company_settings
  enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
  enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
  enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert
  const result = (await createInvoice.execute(
    { customer_id: 'cust-1', invoice_date: '2026-10-02', items: ITEMS, ...args },
    'company-1',
    'user-1',
    supabase as never,
  )) as { staged: boolean }
  const insert = findCalls('pending_operations', 'insert')[0]?.[0] as { params?: Record<string, unknown> } | undefined
  return { result, params: insert?.params ?? {} }
}

describe('gnubok_create_invoice: qr_mode', () => {
  it('declares the closed set of modes', () => {
    const property = (createInvoice.inputSchema.properties as Record<string, { enum?: unknown[] }>).qr_mode
    expect(property.enum).toEqual(['auto', 'bank_app', 'swish', 'payment_link', 'none'])
  })

  it('stages the chosen mode for approval', async () => {
    const { result, params } = await stage({ qr_mode: 'swish' })
    expect(result.staged).toBe(true)
    expect(params.qr_mode).toBe('swish')
  })

  it('stages no mode when it is omitted or null: the invoice inherits the company default', async () => {
    expect((await stage({})).params).not.toHaveProperty('qr_mode')
    expect((await stage({ qr_mode: null })).params).not.toHaveProperty('qr_mode')
  })

  it('refuses a value that is not a mode before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createInvoice.execute(
        { customer_id: 'cust-1', items: ITEMS, qr_mode: 'all_three' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/qr_mode/)
  })
})
