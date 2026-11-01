import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const pricesCreate = vi.fn()
const paymentLinksCreate = vi.fn()
const paymentLinksUpdate = vi.fn()

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    prices: { create: pricesCreate },
    paymentLinks: { create: paymentLinksCreate, update: paymentLinksUpdate },
  }),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

vi.mock('@/lib/sandbox/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/guard')>()
  return { ...actual, isSandboxCompany: vi.fn().mockResolvedValue(false) }
})

import { hasCapability } from '@/lib/entitlements/has-capability'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import {
  createInvoicePaymentLink,
  deactivatePaymentLink,
  handleInvoicePaid,
  handleCreditNoteCreated,
} from '../lib/payment-links'

const ACTIVE_CONNECTION = {
  id: 'conn-1',
  stripe_account_id: 'acct_1',
  livemode: false, // matches sk_test_ platform key stubbed below
}

function makeEligibleInvoice() {
  return makeInvoice({
    id: 'inv-1',
    invoice_number: 'F-2026-0001',
    currency: 'SEK',
    total: 1250,
    remaining_amount: 1250,
    // Its own öresavrundning choice: no company read unless a test drops it.
    ore_rounding: true,
    payment_link_url: null,
  })
}

describe('stripe payment links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(hasCapability).mockResolvedValue(true)
    vi.mocked(isSandboxCompany).mockResolvedValue(false)
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
    vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_test_123')
    pricesCreate.mockResolvedValue({ id: 'price_1' })
    paymentLinksCreate.mockResolvedValue({
      id: 'plink_1',
      url: 'https://buy.stripe.com/test_abc',
    })
    paymentLinksUpdate.mockResolvedValue({ id: 'plink_1', active: false })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('createInvoicePaymentLink', () => {
    it('returns null when Connect is not configured', async () => {
      vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', '')
      const { supabase } = createQueuedMockSupabase()
      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', makeEligibleInvoice(),
      )
      expect(result).toBeNull()
      expect(pricesCreate).not.toHaveBeenCalled()
    })

    it('returns null for sandbox companies (no external calls)', async () => {
      vi.mocked(isSandboxCompany).mockResolvedValue(true)
      const { supabase } = createQueuedMockSupabase()
      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', makeEligibleInvoice(),
      )
      expect(result).toBeNull()
      expect(pricesCreate).not.toHaveBeenCalled()
    })

    it('returns null without the stripe_payments capability', async () => {
      vi.mocked(hasCapability).mockResolvedValue(false)
      const { supabase } = createQueuedMockSupabase()
      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', makeEligibleInvoice(),
      )
      expect(result).toBeNull()
    })

    it('returns null without an active connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null }) // stripe_connections maybeSingle
      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', makeEligibleInvoice(),
      )
      expect(result).toBeNull()
      expect(pricesCreate).not.toHaveBeenCalled()
    })

    it('returns null on live/test mode drift between key and connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { ...ACTIVE_CONNECTION, livemode: true } }) // key is sk_test_
      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', makeEligibleInvoice(),
      )
      expect(result).toBeNull()
      expect(pricesCreate).not.toHaveBeenCalled()
    })

    it('returns null when nothing is payable', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      const invoice = makeEligibleInvoice()
      invoice.status = 'paid'
      invoice.remaining_amount = 0
      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )
      expect(result).toBeNull()
    })

    it('creates a single-use link for the payable amount in öre on the connected account', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      const invoice = makeEligibleInvoice()
      // ROT/RUT: the customer pays the total less the deduction
      invoice.total = 2000
      invoice.deduction_total = 765.44
      invoice.remaining_amount = 1234.56

      const result = await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )

      expect(result).toEqual({ url: 'https://buy.stripe.com/test_abc', externalId: 'plink_1' })
      expect(pricesCreate).toHaveBeenCalledWith(
        {
          currency: 'sek',
          unit_amount: 123456,
          product_data: { name: 'Faktura F-2026-0001' },
        },
        { stripeAccount: 'acct_1', idempotencyKey: 'acc_inv_price_inv-1_123456' },
      )
      expect(paymentLinksCreate).toHaveBeenCalledWith(
        {
          line_items: [{ price: 'price_1', quantity: 1 }],
          restrictions: { completed_sessions: { limit: 1 } },
          metadata: {
            invoice_id: 'inv-1',
            company_id: 'company-1',
            invoice_number: 'F-2026-0001',
          },
        },
        { stripeAccount: 'acct_1', idempotencyKey: 'acc_inv_plink_inv-1_123456' },
      )
    })

    it('derives fresh idempotency keys when the payable amount changes', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      enqueue({ data: ACTIVE_CONNECTION })
      const invoice = makeEligibleInvoice()
      invoice.total = 1250

      await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )
      // Draft amount changed before a resend: reusing the old key with new
      // parameters would be rejected by Stripe (idempotency_error).
      invoice.total = 999.5
      invoice.ore_rounding = false
      await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )

      expect(pricesCreate.mock.calls[0][1].idempotencyKey).toBe('acc_inv_price_inv-1_125000')
      expect(pricesCreate.mock.calls[1][1].idempotencyKey).toBe('acc_inv_price_inv-1_99950')
      expect(paymentLinksCreate.mock.calls[0][1].idempotencyKey).toBe('acc_inv_plink_inv-1_125000')
      expect(paymentLinksCreate.mock.calls[1][1].idempotencyKey).toBe('acc_inv_plink_inv-1_99950')
    })

    // crm#1568: the link charged remaining_amount, the exact ledger figure, so
    // an invoice whose PDF asks 3 116 kr charged 3 116,25 kr by card.
    it('charges what the invoice asks for after öresavrundning, not the exact total', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      const invoice = makeEligibleInvoice()
      invoice.total = 4312.5
      invoice.remaining_amount = 4312.5

      await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )

      expect(pricesCreate.mock.calls[0][0].unit_amount).toBe(431300)
    })

    it('prices a draft without a choice of its own with the company setting', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      enqueue({ data: { ore_rounding: false } }) // company_settings
      const invoice = makeEligibleInvoice()
      invoice.total = 4312.5
      invoice.ore_rounding = null

      await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )

      expect(findCall('company_settings', 'eq')).toEqual(['company_id', 'company-1'])
      expect(pricesCreate.mock.calls[0][0].unit_amount).toBe(431250)
    })

    it('creates no link when the company setting cannot be read', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      enqueue({ error: { message: 'permission denied' } })
      const invoice = makeEligibleInvoice()
      invoice.ore_rounding = null

      await expect(
        createInvoicePaymentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice),
      ).rejects.toThrow(/ore_rounding/)
      expect(pricesCreate).not.toHaveBeenCalled()
    })

    it('charges the remainder of a partly paid invoice', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      const invoice = makeEligibleInvoice()
      invoice.status = 'partially_paid'
      invoice.total = 4312.5
      invoice.paid_amount = 1000
      invoice.remaining_amount = 3312.5

      await createInvoicePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'user-1', invoice,
      )

      expect(pricesCreate.mock.calls[0][0].unit_amount).toBe(331250)
    })

    it('propagates Stripe API failures to the caller', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      pricesCreate.mockRejectedValue(new Error('rate limited'))
      await expect(
        createInvoicePaymentLink(
          supabase as unknown as SupabaseClient, 'company-1', 'user-1', makeEligibleInvoice(),
        ),
      ).rejects.toThrow('rate limited')
    })
  })

  describe('deactivation', () => {
    it('deactivates via the connected account', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      const ok = await deactivatePaymentLink(
        supabase as unknown as SupabaseClient, 'company-1', 'plink_1',
      )
      expect(ok).toBe(true)
      expect(paymentLinksUpdate).toHaveBeenCalledWith(
        'plink_1',
        { active: false },
        { stripeAccount: 'acct_1' },
      )
    })

    it('invoice.paid handler is a no-op without a stripe link id', async () => {
      const { supabase } = createQueuedMockSupabase()
      await handleInvoicePaid(
        { invoice: makeInvoice({ stripe_payment_link_id: null }), companyId: 'company-1' },
        { supabase } as never,
      )
      expect(paymentLinksUpdate).not.toHaveBeenCalled()
    })

    it('invoice.paid handler deactivates the link and swallows failures', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: ACTIVE_CONNECTION })
      paymentLinksUpdate.mockRejectedValue(new Error('gone'))
      await expect(
        handleInvoicePaid(
          {
            invoice: makeInvoice({ stripe_payment_link_id: 'plink_1' }),
            companyId: 'company-1',
          },
          { supabase } as never,
        ),
      ).resolves.toBeUndefined()
      expect(paymentLinksUpdate).toHaveBeenCalled()
      // Nothing retries it and the link keeps taking money: an error, not a warning.
      expect(log.error).toHaveBeenCalledWith('failed to deactivate payment link after invoice paid', expect.objectContaining({ companyId: 'company-1', paymentLinkId: 'plink_1', reason: 'gone' }))
    })

    it('credit_note.created handler reports a failed read of the credited invoice instead of reading it as no link', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: { message: 'canceling statement due to statement timeout' } })
      await handleCreditNoteCreated(
        { creditNote: { credited_invoice_id: 'inv-orig' } as never, companyId: 'company-1' },
        { supabase } as never,
      )
      expect(paymentLinksUpdate).not.toHaveBeenCalled()
      expect(log.error).toHaveBeenCalledWith('failed to deactivate payment link after credit note', expect.objectContaining({ invoiceId: 'inv-orig', reason: expect.stringContaining('credited invoice read failed') }))
    })

    it('credit_note.created handler deactivates the ORIGINAL invoice link', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'inv-orig', stripe_payment_link_id: 'plink_9' } }) // original invoice
      enqueue({ data: ACTIVE_CONNECTION })
      await handleCreditNoteCreated(
        {
          creditNote: { credited_invoice_id: 'inv-orig' } as never,
          companyId: 'company-1',
        },
        { supabase } as never,
      )
      expect(paymentLinksUpdate).toHaveBeenCalledWith(
        'plink_9',
        { active: false },
        { stripeAccount: 'acct_1' },
      )
    })
  })
})
