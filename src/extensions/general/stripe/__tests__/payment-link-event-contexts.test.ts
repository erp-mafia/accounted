import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

/**
 * The Stripe handlers through the real extension registry and context
 * factory, once per path that emits invoice.paid / credit_note.created.
 *
 * Only a dashboard request carries a session cookie. A v1 API key, an MCP
 * bearer token and a provider webhook run inside a request whose cookie
 * client is the anon role (RLS hands it no rows); a cron or the outbox
 * dispatcher has no request scope at all, and the cookie client throws. The
 * handler context must read the company's rows in every one of them (B15: a
 * credit note issued over v1/MCP left the credited invoice's payment link
 * active, so the customer could still pay a voided claim).
 */

const { stripeUpdate, cookieMode } = vi.hoisted(() => ({
  stripeUpdate: vi.fn(),
  cookieMode: { current: 'anon' as 'session' | 'anon' | 'no-request' },
}))

// The company's rows, as the service role (or a session under RLS) sees them.
const service = createTableMockSupabase({
  invoices: { data: { id: 'inv-orig', stripe_payment_link_id: 'plink_9' } },
  stripe_connections: { data: { id: 'conn-1', stripe_account_id: 'acct_1', livemode: false } },
})
// The anon role: every table answers no rows.
const anon = createTableMockSupabase()

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({ paymentLinks: { update: stripeUpdate } }),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => service.supabase),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    if (cookieMode.current === 'no-request') throw new Error('cookies() was called outside a request scope')
    return cookieMode.current === 'session' ? service.supabase : anon.supabase
  }),
}))

// The context factory's core-services import chain is not under test.
vi.mock('@/lib/transactions/ingest', () => ({ ingestTransactions: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import { extensionRegistry, setContextFactory } from '@/lib/extensions/registry'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { stripeExtension } from '../index'

const EMIT_PATHS = [
  ['dashboard request (session cookie)', 'session'],
  ['v1 API key / MCP bearer / webhook request (anon cookie client)', 'anon'],
  ['cron or outbox dispatcher (no request scope)', 'no-request'],
] as const

describe('stripe payment-link handlers in every emit path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    service.reset()
    anon.reset()
    eventBus.clear()
    extensionRegistry.clear()
    setContextFactory(createExtensionContext)
    extensionRegistry.register(stripeExtension)
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
    vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_test_123')
    stripeUpdate.mockResolvedValue({ id: 'plink_9', active: false })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    extensionRegistry.clear()
  })

  it.each(EMIT_PATHS)('credit_note.created deactivates the credited invoice link: %s', async (_label, mode) => {
    cookieMode.current = mode

    await eventBus.emit({
      type: 'credit_note.created',
      payload: {
        creditNote: { id: 'cn-1', credited_invoice_id: 'inv-orig' } as never,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(stripeUpdate).toHaveBeenCalledTimes(1)
    expect(stripeUpdate).toHaveBeenCalledWith('plink_9', { active: false }, { stripeAccount: 'acct_1' })
    // Service role has no RLS: the read is scoped to the emitting company.
    expect(service.findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(service.findCalls('stripe_connections', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it.each(EMIT_PATHS)('invoice.paid deactivates the paid invoice link: %s', async (_label, mode) => {
    cookieMode.current = mode

    await eventBus.emit({
      type: 'invoice.paid',
      payload: {
        invoice: { id: 'inv-1', stripe_payment_link_id: 'plink_9' } as never,
        paymentAmount: 1250,
        paymentDate: '2026-10-26',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(stripeUpdate).toHaveBeenCalledTimes(1)
    expect(stripeUpdate).toHaveBeenCalledWith('plink_9', { active: false }, { stripeAccount: 'acct_1' })
    expect(service.findCalls('stripe_connections', 'eq')).toContainEqual(['company_id', 'company-1'])
  })
})
