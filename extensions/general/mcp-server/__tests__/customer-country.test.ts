/**
 * customers.country through the MCP tools: ISO 3166-1 alpha-2, derived from
 * the VAT prefix when an EU business omits it, and checked against the
 * customer type at staging (#2025, #2028).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { tools } from '../server'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const createTool = () => tools.find((candidate) => candidate.name === 'gnubok_create_customer')!
const updateTool = () => tools.find((candidate) => candidate.name === 'gnubok_update_customer')!

function currentCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    name: 'Test Customer AB',
    customer_type: 'swedish_business',
    customer_number: '1001',
    email: 'billing@example.test',
    phone: '',
    address_line1: 'Testgatan 1',
    address_line2: null,
    postal_code: '12345',
    city: 'Teststad',
    country: 'SE',
    org_number: '556000-0000',
    vat_number: null,
    vat_number_validated: false,
    language: 'sv',
    default_payment_terms: 30,
    notes: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_create_customer: country', () => {
  it('documents the code shape and the type rule in the input schema', () => {
    const properties = createTool().inputSchema.properties as Record<string, Record<string, unknown>>
    expect(String(properties.country.description)).toMatch(/ISO 3166-1 alpha-2/)
    expect(String(properties.country.description)).toMatch(/default SE/)
  })

  it('previews a country name as its code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings read (payment-terms default)

    const result = (await createTool().execute(
      {
        name: 'Muster Handels GmbH',
        customer_type: 'eu_business',
        country: 'Tyskland',
        vat_number: 'DE811234567',
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.country).toBe('DE')
  })

  it('derives the country from the VAT prefix when an EU business omits it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = (await createTool().execute(
      { name: 'Muster Handels GmbH', customer_type: 'eu_business', vat_number: 'DE811234567', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.country).toBe('DE')
  })

  it('defaults a Swedish business to SE, never to the name Sweden', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = (await createTool().execute(
      { name: 'Kund AB', customer_type: 'swedish_business', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.country).toBe('SE')
  })

  it('refuses an EU business with land Sverige before staging (#2025)', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createTool().execute(
        { name: 'Muster Handels GmbH', customer_type: 'eu_business', country: 'SE', vat_number: 'DE811234567' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/country/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses an EU business with neither a country nor a usable VAT prefix', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createTool().execute(
        { name: 'Muster Handels GmbH', customer_type: 'eu_business', vat_number: '811234567' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/country is required/i)
  })

  it('refuses a country it cannot read as a code', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createTool().execute(
        { name: 'Kund AB', customer_type: 'swedish_business', country: 'Atlantis' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not an ISO 3166-1 alpha-2 code/i)
  })
})

describe('gnubok_update_customer: country', () => {
  it('previews a country name as its code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() })

    const result = (await updateTool().execute(
      {
        customer_id: CUSTOMER_ID,
        customer_type: 'eu_business',
        country: 'Tyskland',
        vat_number: 'DE811234567',
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: { proposed?: Record<string, unknown> } }

    expect(result.preview.proposed).toMatchObject({ customer_type: 'eu_business', country: 'DE' })
  })

  it('refuses a type change that contradicts the stored country', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() })

    await expect(
      updateTool().execute(
        { customer_id: CUSTOMER_ID, customer_type: 'eu_business', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/country/i)
  })

  it('refuses a country change that contradicts the stored VAT prefix', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer({ customer_type: 'eu_business', country: 'DE', vat_number: 'DE811234567' }) })

    await expect(
      updateTool().execute(
        { customer_id: CUSTOMER_ID, country: 'FR', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/prefix/i)
  })

  it('refuses a country it cannot read as a code before touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute(
        { customer_id: CUSTOMER_ID, country: 'Atlantis', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/country/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
