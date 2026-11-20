import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Stripe from 'stripe'

/**
 * The customer portal offers exactly the prices checkout sells. The case
 * behind it: the account's default configuration, kept by hand in the Stripe
 * Dashboard, still offered the pre-raise 199 a month and 1 999 a year after
 * checkout moved to 249 and 2 388, and a customer on 249 a month switched to
 * a year at 1 999. Stripe is a recorded fake.
 */

const OLD_MONTHLY = 'price_old_199'
const OLD_YEARLY = 'price_old_1999'
const MONTHLY = 'price_249'
const YEARLY = 'price_2388'

const configurationsList = vi.fn()
const configurationsCreate = vi.fn()
const pricesRetrieve = vi.fn()
const sessionsCreate = vi.fn()
const stripe = {
  billingPortal: {
    configurations: { list: configurationsList, create: configurationsCreate },
    sessions: { create: sessionsCreate },
  },
  prices: { retrieve: pricesRetrieve },
} as unknown as Stripe

vi.mock('@/lib/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe/client')>()),
  getStripe: () => stripe,
}))

import { createPortalSession } from '../portal-session'

type ConfigShape = { id: string; prices: string[]; managed?: string | null; switching?: boolean }

function configuration({ id, prices, managed = null, switching = true }: ConfigShape): Stripe.BillingPortal.Configuration {
  return {
    id,
    metadata: managed ? { accounted_portal: managed } : {},
    features: {
      subscription_update: {
        enabled: switching,
        products: [{ product: 'prod_plan', prices, adjustable_quantity: { enabled: true } }],
      },
    },
  } as unknown as Stripe.BillingPortal.Configuration
}

/** What configurations.list answers: an auto-paging list, iterated with for await. */
function listOf(configs: Stripe.BillingPortal.Configuration[]) {
  return (async function* () {
    yield* configs
  })()
}

const DEFAULT_WITH_OLD_PRICES = configuration({ id: 'bpc_default', prices: [OLD_MONTHLY, OLD_YEARLY] })
const SESSION = { customer: 'cus_1', return_url: 'https://app.accounted.test/settings/billing', locale: 'sv' } as const

const savedEnv = { monthly: process.env.STRIPE_PRICE_MONTHLY, yearly: process.env.STRIPE_PRICE_YEARLY }

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.STRIPE_PRICE_MONTHLY = MONTHLY
  process.env.STRIPE_PRICE_YEARLY = YEARLY
  configurationsCreate.mockResolvedValue({ id: 'bpc_new' })
  pricesRetrieve.mockImplementation(async (id: string) => ({ id, product: 'prod_plan' }))
  sessionsCreate.mockResolvedValue({ url: 'https://billing.stripe.test/session' })
})

afterEach(() => {
  restore('STRIPE_PRICE_MONTHLY', savedEnv.monthly)
  restore('STRIPE_PRICE_YEARLY', savedEnv.yearly)
})

describe('createPortalSession', () => {
  it('never opens on the default configuration: it makes one offering only the checkout prices', async () => {
    configurationsList.mockReturnValue(listOf([DEFAULT_WITH_OLD_PRICES]))

    const session = await createPortalSession(SESSION)

    expect(session.url).toBe('https://billing.stripe.test/session')
    expect(sessionsCreate).toHaveBeenCalledWith({ ...SESSION, configuration: 'bpc_new' })
    expect(configurationsCreate).toHaveBeenCalledTimes(1)
    const created = configurationsCreate.mock.calls[0][0] as Stripe.BillingPortal.ConfigurationCreateParams
    expect(created.features.subscription_update).toMatchObject({
      enabled: true,
      default_allowed_updates: ['price'],
      products: [{ product: 'prod_plan', prices: [MONTHLY, YEARLY], adjustable_quantity: { enabled: false } }],
    })
    expect(created.metadata).toEqual({ accounted_portal: 'v1' })
  })

  it('asks Stripe for the plan list, which it leaves out of a configuration unless asked', async () => {
    configurationsList.mockReturnValue(listOf([]))

    await createPortalSession(SESSION)

    expect(configurationsList).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, expand: ['data.features.subscription_update.products'] }),
    )
  })

  it('reuses a configuration it made for the same prices, in either order', async () => {
    configurationsList.mockReturnValue(
      listOf([DEFAULT_WITH_OLD_PRICES, configuration({ id: 'bpc_ours', prices: [YEARLY, MONTHLY], managed: 'v1' })]),
    )

    await createPortalSession(SESSION)

    expect(configurationsCreate).not.toHaveBeenCalled()
    expect(sessionsCreate).toHaveBeenCalledWith({ ...SESSION, configuration: 'bpc_ours' })
  })

  it('replaces a configuration of ours whose prices are not the checkout prices any more', async () => {
    configurationsList.mockReturnValue(
      listOf([
        // Made before a price change.
        configuration({ id: 'bpc_before_raise', prices: [OLD_MONTHLY, OLD_YEARLY], managed: 'v1' }),
        // Ours, with an old price added in the Dashboard.
        configuration({ id: 'bpc_edited', prices: [MONTHLY, YEARLY, OLD_YEARLY], managed: 'v1' }),
        // Ours, from an older set of features.
        configuration({ id: 'bpc_old_features', prices: [MONTHLY, YEARLY], managed: 'v0' }),
      ]),
    )

    await createPortalSession(SESSION)

    expect(sessionsCreate).toHaveBeenCalledWith({ ...SESSION, configuration: 'bpc_new' })
  })

  it('offers no plan switch at all where no plan price is configured', async () => {
    delete process.env.STRIPE_PRICE_MONTHLY
    delete process.env.STRIPE_PRICE_YEARLY
    configurationsList.mockReturnValue(listOf([DEFAULT_WITH_OLD_PRICES]))

    await createPortalSession(SESSION)

    const created = configurationsCreate.mock.calls[0][0] as Stripe.BillingPortal.ConfigurationCreateParams
    expect(created.features.subscription_update).toEqual({ enabled: false })
    expect(pricesRetrieve).not.toHaveBeenCalled()
    expect(sessionsCreate).toHaveBeenCalledWith({ ...SESSION, configuration: 'bpc_new' })
  })

  it('reuses its no-switch configuration rather than making one per session', async () => {
    delete process.env.STRIPE_PRICE_MONTHLY
    delete process.env.STRIPE_PRICE_YEARLY
    configurationsList.mockReturnValue(
      listOf([configuration({ id: 'bpc_no_switch', prices: [], managed: 'v1', switching: false })]),
    )

    await createPortalSession(SESSION)

    expect(configurationsCreate).not.toHaveBeenCalled()
    expect(sessionsCreate).toHaveBeenCalledWith({ ...SESSION, configuration: 'bpc_no_switch' })
  })

  it('opens no session when the configuration cannot be made', async () => {
    configurationsList.mockReturnValue(listOf([DEFAULT_WITH_OLD_PRICES]))
    configurationsCreate.mockRejectedValue(new Error('No such price'))

    await expect(createPortalSession(SESSION)).rejects.toThrow('No such price')
    expect(sessionsCreate).not.toHaveBeenCalled()
  })
})
