/**
 * gnubok_create_invoice and gnubok_update_invoice: the invoice's own
 * leveransadress (crm#1547), validated at staging with the web API's schema
 * and staged normalized; omitted stages nothing. Names are made up.
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

const ITEMS = [{ description: 'Varor', quantity: 1, unit: 'st', unit_price: 1000 }]

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

describe('gnubok_create_invoice: delivery_address', () => {
  it('stages the address normalized for approval', async () => {
    const { result, params } = await stage({
      delivery_address: { name: ' Exempelbutiken ', address_line1: 'Provgatan 12', postal_code: '111 22', city: 'Exempelstad', country: 'se' },
    })
    expect(result.staged).toBe(true)
    expect(params.delivery_address).toEqual({
      name: 'Exempelbutiken',
      address_line1: 'Provgatan 12',
      address_line2: null,
      postal_code: '111 22',
      city: 'Exempelstad',
      country: 'SE',
    })
  })

  it('stages nothing when it is omitted or empty', async () => {
    expect((await stage({})).params).not.toHaveProperty('delivery_address')
    expect((await stage({ delivery_address: {} })).params).not.toHaveProperty('delivery_address')
  })

  it('refuses an unknown key or a country name before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    for (const delivery_address of [{ street: 'Provgatan 12' }, { city: 'Exempelstad', country: 'Sverige' }]) {
      await expect(
        createInvoice.execute({ customer_id: 'cust-1', items: ITEMS, delivery_address }, 'company-1', 'user-1', supabase as never),
      ).rejects.toThrow(/delivery_address/)
    }
  })
})
