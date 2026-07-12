import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extensionRegistry } from '@/lib/extensions/registry'
import {
  maybeCreatePaymentLinkForInvoice,
  applyPaymentLinkToInvoice,
} from '@/lib/extensions/payment-links'
import { makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'

const supabase = {} as SupabaseClient
const log = { warn: vi.fn() }

function eligibleInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return makeInvoice({
    payment_link_url: null,
    document_type: 'invoice',
    credited_invoice_id: null,
    ...overrides,
  })
}

function registerProvider(create: (...args: unknown[]) => Promise<unknown>) {
  extensionRegistry.register({
    id: 'fake-psp',
    name: 'Fake PSP',
    version: '1.0.0',
    services: { createInvoicePaymentLink: create as (...args: unknown[]) => Promise<unknown> },
  })
}

describe('maybeCreatePaymentLinkForInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    extensionRegistry.unregister('fake-psp')
  })

  it('returns null when no provider extension is registered', async () => {
    const result = await maybeCreatePaymentLinkForInvoice(
      supabase, 'company-1', 'user-1', eligibleInvoice(), log,
    )
    expect(result).toBeNull()
  })

  it.each([
    ['a manually pasted link exists', { payment_link_url: 'https://buy.stripe.com/x' }],
    ['the per-invoice toggle is off', { payment_link_auto: false }],
    ['the document is a proforma', { document_type: 'proforma' as const }],
    ['the document is a credit note', { credited_invoice_id: 'orig-1' }],
  ])('skips the provider when %s', async (_label, overrides) => {
    const create = vi.fn()
    registerProvider(create)
    const result = await maybeCreatePaymentLinkForInvoice(
      supabase, 'company-1', 'user-1', eligibleInvoice(overrides as Partial<Invoice>), log,
    )
    expect(result).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('returns the provider link on success', async () => {
    const create = vi.fn().mockResolvedValue({
      url: 'https://buy.stripe.com/test_abc',
      externalId: 'plink_1',
    })
    registerProvider(create)
    const invoice = eligibleInvoice()
    const result = await maybeCreatePaymentLinkForInvoice(
      supabase, 'company-1', 'user-1', invoice, log,
    )
    expect(result).toEqual({
      ok: true,
      url: 'https://buy.stripe.com/test_abc',
      externalId: 'plink_1',
    })
    expect(create).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', invoice)
  })

  it('treats a provider null (not eligible) as no link', async () => {
    registerProvider(vi.fn().mockResolvedValue(null))
    const result = await maybeCreatePaymentLinkForInvoice(
      supabase, 'company-1', 'user-1', eligibleInvoice(), log,
    )
    expect(result).toBeNull()
  })

  it('never throws: a provider failure becomes { ok: false, reason }', async () => {
    registerProvider(vi.fn().mockRejectedValue(new Error('stripe down')))
    const result = await maybeCreatePaymentLinkForInvoice(
      supabase, 'company-1', 'user-1', eligibleInvoice(), log,
    )
    expect(result).toEqual({ ok: false, reason: 'stripe down' })
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('applyPaymentLinkToInvoice', () => {
  function mockPersist(error: { message: string } | null) {
    const eqCompany = vi.fn().mockResolvedValue({ error })
    const eqId = vi.fn().mockReturnValue({ eq: eqCompany })
    const update = vi.fn().mockReturnValue({ eq: eqId })
    const from = vi.fn().mockReturnValue({ update })
    return { client: { from } as unknown as SupabaseClient, from, update, eqId, eqCompany }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    extensionRegistry.unregister('fake-psp')
  })

  it('is a no-op when no provider is registered', async () => {
    const persist = mockPersist(null)
    const invoice = eligibleInvoice()
    const result = await applyPaymentLinkToInvoice(
      persist.client, 'company-1', 'user-1', invoice, log,
    )
    expect(result).toEqual({ failure: null })
    expect(persist.from).not.toHaveBeenCalled()
    expect(invoice.payment_link_url).toBeNull()
  })

  it('persists the link, then mirrors it onto the invoice object', async () => {
    registerProvider(vi.fn().mockResolvedValue({
      url: 'https://buy.stripe.com/test_abc',
      externalId: 'plink_1',
    }))
    const persist = mockPersist(null)
    const invoice = eligibleInvoice()
    const result = await applyPaymentLinkToInvoice(
      persist.client, 'company-1', 'user-1', invoice, log,
    )
    expect(result).toEqual({ failure: null })
    expect(persist.update).toHaveBeenCalledWith({
      payment_link_url: 'https://buy.stripe.com/test_abc',
      stripe_payment_link_id: 'plink_1',
    })
    expect(persist.eqId).toHaveBeenCalledWith('id', invoice.id)
    expect(persist.eqCompany).toHaveBeenCalledWith('company_id', 'company-1')
    expect(invoice.payment_link_url).toBe('https://buy.stripe.com/test_abc')
    expect(invoice.stripe_payment_link_id).toBe('plink_1')
  })

  it('persist failure returns { failure } and does NOT mutate the invoice', async () => {
    registerProvider(vi.fn().mockResolvedValue({
      url: 'https://buy.stripe.com/test_abc',
      externalId: 'plink_1',
    }))
    const persist = mockPersist({ message: 'row is locked' })
    const invoice = eligibleInvoice()
    const result = await applyPaymentLinkToInvoice(
      persist.client, 'company-1', 'user-1', invoice, log,
      { logPrefix: 'invoices.send: ', logContext: { invoiceId: invoice.id } },
    )
    expect(result).toEqual({ failure: 'row is locked' })
    expect(invoice.payment_link_url).toBeNull()
    expect(invoice.stripe_payment_link_id).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      'invoices.send: payment link created but not persisted; sending without it',
      { invoiceId: invoice.id, err: { message: 'row is locked' } },
    )
  })

  it('provider failure returns { failure: reason } without touching the DB', async () => {
    registerProvider(vi.fn().mockRejectedValue(new Error('stripe down')))
    const persist = mockPersist(null)
    const invoice = eligibleInvoice()
    const result = await applyPaymentLinkToInvoice(
      persist.client, 'company-1', 'user-1', invoice, log,
    )
    expect(result).toEqual({ failure: 'stripe down' })
    expect(persist.from).not.toHaveBeenCalled()
    expect(invoice.payment_link_url).toBeNull()
  })

  it('passes the invoiceNumber override to the provider without mutating the invoice', async () => {
    const create = vi.fn().mockResolvedValue({
      url: 'https://buy.stripe.com/test_abc',
      externalId: 'plink_1',
    })
    registerProvider(create)
    const persist = mockPersist(null)
    const invoice = eligibleInvoice({ invoice_number: null })
    await applyPaymentLinkToInvoice(
      persist.client, 'company-1', 'user-1', invoice, log,
      { invoiceNumber: 'F-2026-0042' },
    )
    expect(create).toHaveBeenCalledWith(
      persist.client,
      'company-1',
      'user-1',
      expect.objectContaining({ invoice_number: 'F-2026-0042' }),
    )
    expect(invoice.invoice_number).toBeNull()
  })
})
