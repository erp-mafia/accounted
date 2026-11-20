/**
 * The state or province of a US or Canadian customer (customers.address_state):
 * taken by the register's one rule set, trimmed, and blank stored as none.
 * Every name and address is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/invoices/sync-draft-vat-headers', () => ({
  syncDraftVatHeadersForCustomer: vi.fn().mockResolvedValue(0),
}))

import { createQueuedMockSupabase } from '@/tests/helpers'
import { CreateCustomerSchema, UpdateCustomerSchema } from '@/lib/api/schemas'
import { createCustomer, updateCustomer } from '../customer-commands'
import type { Logger } from '@/lib/logger'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const usCustomer = {
  name: 'Example Corp',
  customer_type: 'non_eu_business',
  address_line1: '100 Example Ave',
  postal_code: '98006',
  city: 'Bellevue',
  country: 'US',
  default_payment_terms: 30,
}

function context() {
  const mock = createQueuedMockSupabase()
  return { ...mock, ctx: { supabase: mock.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the customer schemas', () => {
  it('take a state, trimmed, and refuse one longer than 100 characters', () => {
    expect(CreateCustomerSchema.parse({ ...usCustomer, address_state: ' WA ' }).address_state).toBe('WA')
    expect(UpdateCustomerSchema.parse({ address_state: 'WA' }).address_state).toBe('WA')
    expect(UpdateCustomerSchema.safeParse({ address_state: 'x'.repeat(101) }).success).toBe(false)
  })
})

describe('createCustomer', () => {
  it('stores the state, and none when it is blank', async () => {
    const { ctx } = context()
    const withState = await createCustomer(ctx, CreateCustomerSchema.parse({ ...usCustomer, address_state: 'WA' }), { dryRun: true })
    expect(withState.ok && withState.dryRun && withState.preview.address_state).toBe('WA')

    const blank = await createCustomer(ctx, CreateCustomerSchema.parse({ ...usCustomer, address_state: '' }), { dryRun: true })
    expect(blank.ok && blank.dryRun && blank.preview.address_state).toBeNull()
  })
})

describe('updateCustomer', () => {
  const stored = { id: CUSTOMER_ID, company_id: 'company-1', ...usCustomer, address_state: null, personal_number: null }

  it('writes the state sent', async () => {
    const { ctx, enqueue, findCall } = context()
    enqueue({ data: stored })
    enqueue({ data: { ...stored, address_state: 'WA' } })
    const outcome = await updateCustomer(ctx, CUSTOMER_ID, UpdateCustomerSchema.parse({ address_state: 'WA' }))
    expect(outcome.ok).toBe(true)
    expect(findCall('customers', 'update')?.[0]).toEqual({ address_state: 'WA' })
  })

  it('clears it with a blank, as the form sends for a country without states', async () => {
    const { ctx, enqueue, findCall } = context()
    enqueue({ data: { ...stored, address_state: 'WA' } })
    enqueue({ data: { ...stored, address_state: null } })
    const outcome = await updateCustomer(ctx, CUSTOMER_ID, UpdateCustomerSchema.parse({ address_state: '' }))
    expect(outcome.ok).toBe(true)
    expect(findCall('customers', 'update')?.[0]).toEqual({ address_state: null })
  })
})
