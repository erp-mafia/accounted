import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  NOTHING_ON_FILE,
  billingIdentityChanged,
  checkoutIdentityNotice,
  companyBillingIdentity,
  loadCompanyBillingIdentity,
  stripeCustomerIdentityFields,
  syncCompanyStripeIdentity,
  syncStripeCustomerIdentity,
  type CompanyBillingIdentity,
} from '../customer-identity'

const AB_COMPANY = { name: 'Bolaget AB', org_number: '5566778899', entity_type: 'aktiebolag' }

function settings(overrides: Record<string, unknown> = {}) {
  return {
    entity_type: 'aktiebolag',
    company_name: 'Bolaget AB',
    org_number: '556677-8899',
    address_line1: 'Storgatan 1',
    address_line2: null,
    postal_code: '111 22',
    city: 'Stockholm',
    country: 'SE',
    vat_registered: true,
    vat_number: 'SE556677889901',
    ...overrides,
  }
}

describe('companyBillingIdentity', () => {
  it('maps a momsregistrerat aktiebolag to name, address, VAT number and org number', () => {
    expect(companyBillingIdentity(AB_COMPANY, settings())).toEqual({
      name: 'Bolaget AB',
      address: { line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'SE' },
      vatNumber: 'SE556677889901',
      orgNumber: '556677-8899',
    })
  })

  it('normalizes a stored VAT number written with spaces', () => {
    expect(companyBillingIdentity(AB_COMPANY, settings({ vat_number: 'se 5566778899 01' })).vatNumber).toBe(
      'SE556677889901',
    )
  })

  it('gives no VAT number to a company that is not momsregistrerad, even with one stored', () => {
    expect(companyBillingIdentity(AB_COMPANY, settings({ vat_registered: false })).vatNumber).toBeNull()
  })

  it('never derives a VAT number when a registered company has none stored', () => {
    expect(companyBillingIdentity(AB_COMPANY, settings({ vat_number: null })).vatNumber).toBeNull()
    expect(companyBillingIdentity(AB_COMPANY, settings({ vat_number: 'SE5566778899' })).vatNumber).toBeNull()
  })

  it('keeps an enskild firma personnummer off the invoice and has no VAT number when not registered', () => {
    const identity = companyBillingIdentity(
      { name: 'Firma Test', org_number: '198001019994', entity_type: 'enskild_firma' },
      settings({ entity_type: 'enskild_firma', company_name: 'Firma Test', org_number: '198001019994', vat_registered: false, vat_number: null }),
    )
    expect(identity.orgNumber).toBeNull()
    expect(identity.vatNumber).toBeNull()
    expect(identity.name).toBe('Firma Test')
  })

  it('passes a momsregistrerad enskild firma its stored VAT number', () => {
    const identity = companyBillingIdentity(
      { name: 'Firma Test', org_number: '198001019994', entity_type: 'enskild_firma' },
      settings({ entity_type: 'enskild_firma', org_number: '198001019994', vat_number: 'SE800101999401' }),
    )
    expect(identity.vatNumber).toBe('SE800101999401')
    expect(identity.orgNumber).toBeNull()
  })

  it('reads the number through the one reader: an empty company copy hides nothing', () => {
    expect(companyBillingIdentity({ ...AB_COMPANY, org_number: '' }, settings()).orgNumber).toBe('556677-8899')
    expect(companyBillingIdentity({ ...AB_COMPANY, org_number: '556677-8899' }, settings({ org_number: '' })).orgNumber).toBe('556677-8899')
  })

  it('gives no org number for an unknown legal form or an invalid number', () => {
    expect(companyBillingIdentity({ ...AB_COMPANY, entity_type: null }, settings({ entity_type: null })).orgNumber).toBeNull()
    expect(companyBillingIdentity({ ...AB_COMPANY, org_number: '5566778898' }, settings({ org_number: '5566778898' })).orgNumber).toBeNull()
  })

  it('drops an incomplete address and defaults a missing country to SE', () => {
    expect(companyBillingIdentity(AB_COMPANY, settings({ city: ' ' })).address).toBeNull()
    expect(companyBillingIdentity(AB_COMPANY, settings({ country: null, address_line2: 'Box 1' })).address).toEqual({
      line1: 'Storgatan 1',
      line2: 'Box 1',
      postal_code: '111 22',
      city: 'Stockholm',
      country: 'SE',
    })
  })

  it('falls back to the companies row for the name and is empty without rows', () => {
    expect(companyBillingIdentity(AB_COMPANY, settings({ company_name: '' })).name).toBe('Bolaget AB')
    expect(companyBillingIdentity(null, null)).toEqual({ name: null, address: null, vatNumber: null, orgNumber: null })
  })
})

describe('loadCompanyBillingIdentity', () => {
  const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
  beforeEach(() => reset())

  it('reads both rows filtered by the company', async () => {
    enqueue({ data: AB_COMPANY })
    enqueue({ data: settings() })

    const identity = await loadCompanyBillingIdentity(supabase as never, 'company-1')

    expect(identity.vatNumber).toBe('SE556677889901')
    expect(findCall('companies', 'eq')).toEqual(['id', 'company-1'])
    expect(findCall('company_settings', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('throws when a read fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: settings() })

    await expect(loadCompanyBillingIdentity(supabase as never, 'company-1')).rejects.toThrow('companies lookup failed')
  })
})

describe('stripeCustomerIdentityFields', () => {
  it('sets name, business name, address with immediate tax validation, and the org number field', () => {
    expect(stripeCustomerIdentityFields(companyBillingIdentity(AB_COMPANY, settings()))).toEqual({
      name: 'Bolaget AB',
      business_name: 'Bolaget AB',
      address: { line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'SE' },
      tax: { validate_location: 'immediately' },
      invoice_settings: { custom_fields: [{ name: 'Org.nr', value: '556677-8899' }] },
    })
  })

  it('is empty when nothing is known', () => {
    expect(stripeCustomerIdentityFields({ name: null, address: null, vatNumber: null, orgNumber: null })).toEqual({})
  })
})

describe('syncStripeCustomerIdentity', () => {
  const update = vi.fn()
  const listTaxIds = vi.fn()
  const createTaxId = vi.fn()
  const stripe = { customers: { update, listTaxIds, createTaxId } } as unknown as Stripe

  const full: CompanyBillingIdentity = companyBillingIdentity(AB_COMPANY, settings())

  beforeEach(() => {
    vi.clearAllMocks()
    update.mockResolvedValue({})
    createTaxId.mockResolvedValue({})
    listTaxIds.mockResolvedValue({ data: [] })
  })

  it('adds the VAT number to a just-created customer without listing its tax IDs', async () => {
    const result = await syncStripeCustomerIdentity(stripe, 'cus_new', full, { justCreated: true })

    expect(update).toHaveBeenCalledWith('cus_new', expect.objectContaining({ name: 'Bolaget AB' }))
    expect(listTaxIds).not.toHaveBeenCalled()
    expect(createTaxId).toHaveBeenCalledWith(
      'cus_new',
      { type: 'eu_vat', value: 'SE556677889901' },
      { idempotencyKey: 'customer-tax-id:cus_new:SE556677889901' },
    )
    expect(result).toEqual({ taxIdOnFile: true, addressOnFile: true, nameOnFile: true, taxId: 'SE556677889901' })
  })

  it('updates an existing customer and adds the VAT number when it has no tax ID', async () => {
    const result = await syncStripeCustomerIdentity(stripe, 'cus_old', full, { justCreated: false })

    expect(update).toHaveBeenCalledWith('cus_old', expect.objectContaining({ business_name: 'Bolaget AB' }))
    expect(listTaxIds).toHaveBeenCalledWith('cus_old', { limit: 1 })
    expect(createTaxId).toHaveBeenCalledWith(
      'cus_old',
      { type: 'eu_vat', value: 'SE556677889901' },
      { idempotencyKey: 'customer-tax-id:cus_old:SE556677889901' },
    )
    expect(result.taxIdOnFile).toBe(true)
  })

  it('keeps a tax ID the customer already has and adds no duplicate', async () => {
    listTaxIds.mockResolvedValue({ data: [{ id: 'txi_1', value: 'SE112233445501' }] })

    const result = await syncStripeCustomerIdentity(stripe, 'cus_old', full, { justCreated: false })

    expect(createTaxId).not.toHaveBeenCalled()
    expect(result.taxIdOnFile).toBe(true)
    // The value Stripe holds, which is what the invoice carries, not ours.
    expect(result.taxId).toBe('SE112233445501')
  })

  it('adds no tax ID without a VAT number and reports none on file', async () => {
    const result = await syncStripeCustomerIdentity(stripe, 'cus_old', { ...full, vatNumber: null }, { justCreated: false })

    expect(listTaxIds).not.toHaveBeenCalled()
    expect(createTaxId).not.toHaveBeenCalled()
    expect(result).toEqual({ taxIdOnFile: false, addressOnFile: true, nameOnFile: true, taxId: null })
  })

  it('makes no Stripe call when nothing is known', async () => {
    const result = await syncStripeCustomerIdentity(
      stripe,
      'cus_old',
      { name: null, address: null, vatNumber: null, orgNumber: null },
      { justCreated: false },
    )

    expect(update).not.toHaveBeenCalled()
    expect(result).toEqual({ taxIdOnFile: false, addressOnFile: false, nameOnFile: false, taxId: null })
  })

  it('propagates a Stripe error to the caller', async () => {
    createTaxId.mockRejectedValue(new Error('Invalid value for eu_vat'))

    await expect(syncStripeCustomerIdentity(stripe, 'cus_new', full, { justCreated: true })).rejects.toThrow('eu_vat')
  })
})

describe('billingIdentityChanged', () => {
  it('is false when no identity column moved', () => {
    expect(billingIdentityChanged({ ...settings(), mileage_enabled: false }, { ...settings(), mileage_enabled: true })).toBe(
      false,
    )
  })

  it.each([
    ['company_name', 'Nya Bolaget AB'],
    ['address_line1', 'Lillgatan 2'],
    ['postal_code', '222 33'],
    ['city', 'Uppsala'],
    ['vat_registered', false],
    ['vat_number', 'SE556677889902'],
    ['entity_type', 'handelsbolag'],
  ])('is true when %s moved', (column, value) => {
    expect(billingIdentityChanged(settings(), settings({ [column]: value }))).toBe(true)
  })

  it('treats a missing value and null alike', () => {
    expect(billingIdentityChanged(settings({ address_line2: null }), settings({ address_line2: undefined }))).toBe(false)
  })
})

// crm#1378: the identity was written once, at checkout. A customer that
// subscribed before the prefill, or a company whose details changed later,
// kept invoicing the old details on every renewal.
describe('syncCompanyStripeIdentity', () => {
  const update = vi.fn()
  const listTaxIds = vi.fn()
  const createTaxId = vi.fn()
  const stripe = { customers: { update, listTaxIds, createTaxId } } as unknown as Stripe
  const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    update.mockResolvedValue({})
    createTaxId.mockResolvedValue({})
    listTaxIds.mockResolvedValue({ data: [] })
  })

  it('asks Stripe nothing for a company that never reached checkout', async () => {
    enqueue({ data: null }) // no company_subscriptions row

    expect(await syncCompanyStripeIdentity(supabase, 'company-1', { stripe })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it("writes the company's current identity onto the customer found on its row", async () => {
    enqueue({ data: { stripe_customer_id: 'cus_1' } }) // company_subscriptions
    enqueue({ data: AB_COMPANY }) // companies
    enqueue({ data: settings({ company_name: 'Nya Bolaget AB' }) }) // company_settings

    const result = await syncCompanyStripeIdentity(supabase, 'company-1', { stripe })

    expect(findCall('company_subscriptions', 'eq')).toEqual(['company_id', 'company-1'])
    expect(update).toHaveBeenCalledWith(
      'cus_1',
      expect.objectContaining({ name: 'Nya Bolaget AB', business_name: 'Nya Bolaget AB' }),
    )
    // An existing customer: its tax IDs are listed before one is added.
    expect(listTaxIds).toHaveBeenCalledWith('cus_1', { limit: 1 })
    expect(createTaxId).toHaveBeenCalledWith(
      'cus_1',
      { type: 'eu_vat', value: 'SE556677889901' },
      { idempotencyKey: 'customer-tax-id:cus_1:SE556677889901' },
    )
    expect(result).toEqual({ taxIdOnFile: true, addressOnFile: true, nameOnFile: true, taxId: 'SE556677889901' })
  })

  it('uses the customer the caller already has without reading the row', async () => {
    enqueue({ data: AB_COMPANY }) // companies
    enqueue({ data: settings() }) // company_settings

    await syncCompanyStripeIdentity(supabase, 'company-1', { stripe, customerId: 'cus_from_event' })

    expect(findCall('company_subscriptions', 'select')).toBeUndefined()
    expect(update).toHaveBeenCalledWith('cus_from_event', expect.objectContaining({ name: 'Bolaget AB' }))
  })

  it('throws on a failed row read', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(syncCompanyStripeIdentity(supabase, 'company-1', { stripe })).rejects.toThrow('boom')
    expect(update).not.toHaveBeenCalled()
  })
})

// Agent feedback 2026-11-02: with the identity prefilled, Checkout shows no
// company at all, and the payer concluded they could not enter it.
describe('checkoutIdentityNotice', () => {
  const full: CompanyBillingIdentity = companyBillingIdentity(AB_COMPANY, settings())
  const synced = { taxIdOnFile: true, addressOnFile: true, nameOnFile: true, taxId: 'SE556677889901' }

  it('names what the invoice carries and where to change it, in Swedish', () => {
    expect(checkoutIdentityNotice(full, synced, 'sv')).toBe(
      'Fakturan ställs ut på Bolaget AB, org.nr 556677-8899, momsreg.nr SE556677889901, Storgatan 1, 111 22 Stockholm. ' +
        'Stämmer något inte? Ändra under Inställningar > Företag > Allmänt och starta betalningen igen.',
    )
  })

  it('in English', () => {
    expect(checkoutIdentityNotice(full, synced, 'en')).toBe(
      'The invoice is issued to Bolaget AB, org. no. 556677-8899, VAT no. SE556677889901, Storgatan 1, 111 22 Stockholm. ' +
        'Anything wrong? Change it under Settings > Company > General and start the payment again.',
    )
  })

  it('lists only what is on the customer: no VAT number for a company without one, the tax ID Stripe holds otherwise', () => {
    const noVat = checkoutIdentityNotice({ ...full, vatNumber: null }, { ...synced, taxIdOnFile: false, taxId: null }, 'sv')
    expect(noVat).not.toContain('momsreg.nr')
    expect(noVat).toContain('org.nr 556677-8899')

    const theirs = checkoutIdentityNotice(full, { ...synced, taxId: 'SE112233445501' }, 'sv')
    expect(theirs).toContain('momsreg.nr SE112233445501')
    expect(theirs).not.toContain('SE556677889901')
  })

  it('never shows an enskild firma owner personnummer', () => {
    const ef = companyBillingIdentity(
      { name: 'Firma Test', org_number: '198001019994', entity_type: 'enskild_firma' },
      settings({ entity_type: 'enskild_firma', company_name: 'Firma Test', org_number: '198001019994', vat_registered: false, vat_number: null }),
    )
    const notice = checkoutIdentityNotice(ef, { ...synced, taxIdOnFile: false, taxId: null }, 'sv')
    expect(notice).toContain('Firma Test')
    expect(notice).not.toMatch(/19800101|org\.nr/)
  })

  it('says nothing when no name was written, so Checkout collects the details itself', () => {
    expect(checkoutIdentityNotice(full, NOTHING_ON_FILE, 'sv')).toBeNull()
    expect(checkoutIdentityNotice({ ...full, name: null }, synced, 'sv')).toBeNull()
  })

  it('stays inside Stripe custom_text limit and has no em or en dashes', () => {
    const long = checkoutIdentityNotice({ ...full, name: 'A'.repeat(2000) }, synced, 'sv')!
    expect(long.length).toBeLessThanOrEqual(1200)
    expect(checkoutIdentityNotice(full, synced, 'sv')! + checkoutIdentityNotice(full, synced, 'en')!).not.toMatch(/[\u2013\u2014]/)
  })
})
