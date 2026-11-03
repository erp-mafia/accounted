import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { UsageKind } from '../kinds'

const countMock = vi.hoisted(() => vi.fn())
vi.mock('../counters', () => ({ countUsageByCompany: (...args: unknown[]) => countMock(...args) }))

import { closeUsagePeriod, invoiceLineDescription, previousUsagePeriod } from '../close-period'
import { usageLine } from '../kinds'

type Row = Record<string, unknown>

/** An in-memory service client: reads filter the table's rows, upserts are recorded. */
function fakeService(tables: Record<string, Row[]>) {
  const upserts: Row[] = []
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = []
    const builder = {
      select: () => builder,
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]))
        return builder
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value)
        return builder
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value)
        return builder
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value)
        return builder
      },
      order: () => builder,
      range: () => builder,
      upsert: (rows: Row[]) => {
        upserts.push(...rows)
        return Promise.resolve({ error: null })
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row))), error: null }),
    }
    return builder
  }
  return { service: { from } as unknown as SupabaseClient, upserts }
}

function fakeStripe() {
  let item = 0
  const invoiceItemsCreate = vi.fn().mockImplementation(async () => ({ id: `ii_${++item}` }))
  const invoicesCreate = vi.fn().mockResolvedValue({ id: 'in_1' })
  const finalizeInvoice = vi.fn().mockResolvedValue({ id: 'in_1', status: 'open' })
  const stripe = { invoices: { create: invoicesCreate, finalizeInvoice }, invoiceItems: { create: invoiceItemsCreate } }
  return { stripe: stripe as unknown as Stripe, invoicesCreate, finalizeInvoice, invoiceItemsCreate }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

function counts(byKind: Partial<Record<UsageKind, Record<string, number>>>) {
  countMock.mockImplementation(async (_service: unknown, kind: UsageKind) => new Map(Object.entries(byKind[kind] ?? {})))
}

const PERIOD = '2026-09'
const monthly = { company_id: 'c1', status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', plan: 'monthly' }
const yearly = { ...monthly, plan: 'yearly' }
const consent = (kind: UsageKind, unit_price_ore: number) => ({
  company_id: 'c1',
  kind,
  unit_price_ore,
  included: 10,
  accepted_by: 'u1',
  accepted_at: '2026-09-12T08:00:00Z',
  revoked_at: null,
})
const BILLED = new Set<UsageKind>(['bank_payment', 'peppol_send'])

beforeEach(() => {
  vi.clearAllMocks()
})

describe('closeUsagePeriod', () => {
  it('writes previews and touches no Stripe while billing is off', async () => {
    counts({ bank_payment: { c1: 14 }, kivra_send: { c1: 3 } })
    const { service, upserts } = fakeService({ company_subscriptions: [monthly], usage_consents: [consent('bank_payment', 200)] })
    const s = fakeStripe()

    const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: new Set(), log })

    expect(s.invoiceItemsCreate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ companies: 1, statements: 2, billed: [], failed: [] })
    expect(upserts).toEqual([
      expect.objectContaining({ kind: 'bank_payment', used: 14, billable: 4, amount_ore: 800, status: 'preview', reason: 'billing_off' }),
      expect.objectContaining({ kind: 'kivra_send', used: 3, included: 0, billable: 3, amount_ore: 900, status: 'preview', reason: 'billing_off' }),
    ])
  })

  it('never bills what nobody accepted', async () => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({ company_subscriptions: [monthly] })
    const s = fakeStripe()

    await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(s.invoiceItemsCreate).not.toHaveBeenCalled()
    expect(upserts).toEqual([expect.objectContaining({ status: 'preview', reason: 'no_consent', amount_ore: 800 })])
  })

  it('needs a new acceptance after a price rise', async () => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({ company_subscriptions: [monthly], usage_consents: [consent('bank_payment', 150)] })

    await closeUsagePeriod(service, PERIOD, { stripe: fakeStripe().stripe, billed: BILLED, log })

    expect(upserts).toEqual([expect.objectContaining({ status: 'preview', reason: 'no_consent' })])
  })

  it("puts a monthly plan's lines on its subscription, for the next subscription invoice", async () => {
    counts({ bank_payment: { c1: 14 }, peppol_send: { c1: 12 } })
    const { service, upserts } = fakeService({
      company_subscriptions: [monthly],
      usage_consents: [consent('bank_payment', 200), consent('peppol_send', 100)],
    })
    const s = fakeStripe()

    const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(result.billed).toEqual([{ companyId: 'c1', amountOre: 1000, invoiceId: null }])
    expect(s.invoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_1',
        subscription: 'sub_1',
        currency: 'sek',
        amount: 800,
        tax_behavior: 'exclusive',
        description: 'Betalningar via banken, september 2026: 4 st à 2,00 kr',
      }),
      { idempotencyKey: 'usage-item:c1:2026-09:bank_payment' },
    )
    expect(s.invoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200, description: 'Skickade e-fakturor via Peppol, september 2026: 2 st à 1,00 kr' }),
      { idempotencyKey: 'usage-item:c1:2026-09:peppol_send' },
    )
    // No bill of its own: the items wait for the subscription's next invoice.
    expect(s.invoicesCreate).not.toHaveBeenCalled()
    expect(upserts.filter((r) => r.status === 'billed')).toEqual([
      expect.objectContaining({ kind: 'bank_payment', stripe_invoice_item_id: 'ii_1', stripe_invoice_id: null }),
      expect.objectContaining({ kind: 'peppol_send', stripe_invoice_item_id: 'ii_2', stripe_invoice_id: null }),
    ])
  })

  it("gives a yearly plan's lines an invoice for the subscription every month, charged at once", async () => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({ company_subscriptions: [yearly], usage_consents: [consent('bank_payment', 200)] })
    const s = fakeStripe()

    const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(result.billed).toEqual([{ companyId: 'c1', amountOre: 800, invoiceId: 'in_1' }])
    expect(s.invoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_1',
        subscription: 'sub_1',
        pending_invoice_items_behavior: 'include',
        collection_method: 'charge_automatically',
        automatic_tax: { enabled: true },
      }),
      { idempotencyKey: 'usage-invoice:c1:2026-09' },
    )
    expect(s.finalizeInvoice).toHaveBeenCalledWith('in_1', { auto_advance: true })
    expect(upserts.at(-1)).toMatchObject({ status: 'billed', stripe_invoice_item_id: 'ii_1', stripe_invoice_id: 'in_1' })
  })

  it('uses the company allowance, packs included, as the included amount for bank payments', async () => {
    counts({ bank_payment: { c1: 110 } })
    const { service, upserts } = fakeService({
      company_subscriptions: [monthly],
      company_bank_payment_allowances: [{ company_id: 'c1', monthly_payments: 10, purchased_packs: 1 }],
      usage_consents: [consent('bank_payment', 200)],
    })

    await closeUsagePeriod(service, PERIOD, { stripe: fakeStripe().stripe, billed: BILLED, log })

    expect(upserts).toEqual([expect.objectContaining({ included: 110, billable: 0, status: 'preview', reason: 'nothing_billable' })])
  })

  it.each([
    ['a trial', { ...monthly, status: 'trialing' }, []],
    ['a past-due card', { ...monthly, status: 'past_due' }, []],
    ['a company without a subscription of its own', null, []],
    ['a demo company', monthly, [{ company_id: 'c1', is_sandbox: true }]],
  ])('never charges %s', async (_label, subscription, settings) => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({
      company_subscriptions: subscription ? [subscription] : [],
      company_settings: settings,
      usage_consents: [consent('bank_payment', 200)],
    })
    const s = fakeStripe()

    await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(s.invoiceItemsCreate).not.toHaveBeenCalled()
    expect(upserts).toEqual([expect.objectContaining({ status: 'preview', reason: 'not_paying', amount_ore: 800 })])
  })

  it('previews everything without Stripe', async () => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({ company_subscriptions: [monthly], usage_consents: [consent('bank_payment', 200)] })

    await closeUsagePeriod(service, PERIOD, { stripe: null, billed: BILLED, log })

    expect(upserts).toEqual([expect.objectContaining({ status: 'preview', reason: 'not_paying' })])
  })

  it('never touches a statement already billed', async () => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({
      company_subscriptions: [monthly],
      usage_consents: [consent('bank_payment', 200)],
      usage_statements: [{ id: 's1', company_id: 'c1', period: PERIOD, kind: 'bank_payment', status: 'billed' }],
    })
    const s = fakeStripe()

    const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(s.invoiceItemsCreate).not.toHaveBeenCalled()
    expect(upserts).toEqual([])
    expect(result.billed).toEqual([])
  })

  it('leaves a company with half-made or failed lines for a person', async () => {
    counts({ bank_payment: { c1: 14 } })
    const { service, upserts } = fakeService({
      company_subscriptions: [monthly],
      usage_consents: [consent('bank_payment', 200)],
      usage_statements: [{ id: 's1', company_id: 'c1', period: PERIOD, kind: 'bank_payment', status: 'failed' }],
    })
    const s = fakeStripe()

    const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(result.needsAttention).toEqual(['c1'])
    expect(s.invoiceItemsCreate).not.toHaveBeenCalled()
    expect(upserts).toEqual([])
  })

  it('records a Stripe refusal on the statements, with the lines it got as far as', async () => {
    counts({ bank_payment: { c1: 14 }, peppol_send: { c1: 12 } })
    const { service, upserts } = fakeService({
      company_subscriptions: [monthly],
      usage_consents: [consent('bank_payment', 200), consent('peppol_send', 100)],
    })
    const s = fakeStripe()
    s.invoiceItemsCreate.mockImplementationOnce(async () => ({ id: 'ii_1' })).mockRejectedValueOnce(new Error('rate_limited'))

    const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed: BILLED, log })

    expect(result.failed).toEqual([{ companyId: 'c1', error: 'rate_limited' }])
    expect(upserts.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'bank_payment', status: 'failed', error: 'rate_limited', stripe_invoice_item_id: 'ii_1' }),
      expect.objectContaining({ kind: 'peppol_send', status: 'failed', error: 'rate_limited', stripe_invoice_item_id: null }),
    ])
  })

  describe('a byrå client covered by its byrå\'s agreement', () => {
    const byraTables = (extra: Record<string, Row[]> = {}): Record<string, Row[]> => ({
      companies: [{ id: 'c2', team_id: 't1' }],
      teams: [{ id: 't1', name: 'Byrån AB', kind: 'byra' }],
      capability_grants: [{ team_id: 't1', source: 'manual', capability_key: 'bookkeeping', expires_at: null }],
      ...extra,
    })
    const accountsOpen = { company_id: 'c2', kind: 'bank_account', unit_price_ore: 2000, included: 2, accepted_by: 'u1', accepted_at: '2026-09-12T08:00:00Z', revoked_at: null }
    const billed = new Set<UsageKind>(['bank_account'])

    it('writes its open lines as manual, for the byrå\'s invoice, and makes no Stripe line', async () => {
      counts({ bank_account: { c2: 4 } })
      const { service, upserts } = fakeService(byraTables({ usage_consents: [accountsOpen] }))
      const s = fakeStripe()

      const result = await closeUsagePeriod(service, PERIOD, { stripe: s.stripe, billed, log })

      expect(s.invoiceItemsCreate).not.toHaveBeenCalled()
      expect(upserts).toEqual([
        expect.objectContaining({ company_id: 'c2', kind: 'bank_account', used: 4, included: 2, billable: 2, amount_ore: 4000, status: 'manual', reason: 'byra_agreement' }),
      ])
      expect(result.manual).toEqual([{ companyId: 'c2', teamId: 't1', teamName: 'Byrån AB', lines: [expect.objectContaining({ kind: 'bank_account', billable: 2 })] }])
      expect(result.billed).toEqual([])
    })

    it('previews what the byrå has not asked to open', async () => {
      counts({ bank_account: { c2: 4 } })
      const { service, upserts } = fakeService(byraTables())
      const result = await closeUsagePeriod(service, PERIOD, { stripe: fakeStripe().stripe, billed, log })
      expect(upserts).toEqual([expect.objectContaining({ company_id: 'c2', status: 'preview', reason: 'no_consent' })])
      expect(result.manual).toEqual([])
    })

    it('never writes or lists a manual line twice on a rerun', async () => {
      counts({ bank_account: { c2: 4 } })
      const { service, upserts } = fakeService(
        byraTables({ usage_consents: [accountsOpen], usage_statements: [{ id: 's1', company_id: 'c2', kind: 'bank_account', status: 'manual', period: PERIOD }] }),
      )
      const result = await closeUsagePeriod(service, PERIOD, { stripe: fakeStripe().stripe, billed, log })
      expect(upserts).toEqual([])
      expect(result.manual).toEqual([])
    })

    it('treats a byrå team whose agreement ended as nobody paying', async () => {
      counts({ bank_account: { c2: 4 } })
      const ended = byraTables({ usage_consents: [accountsOpen] })
      ended.capability_grants = [{ team_id: 't1', source: 'manual', capability_key: 'bookkeeping', expires_at: '2026-01-01T00:00:00Z' }]
      const { service, upserts } = fakeService(ended)
      await closeUsagePeriod(service, PERIOD, { stripe: fakeStripe().stripe, billed, log })
      expect(upserts).toEqual([expect.objectContaining({ status: 'preview', reason: 'not_paying' })])
    })
  })

  it('refuses the current month', async () => {
    const { service } = fakeService({})
    const now = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 7)
    await expect(closeUsagePeriod(service, now, { stripe: null, billed: new Set(), log })).rejects.toThrow(/not a closed month/)
    await expect(closeUsagePeriod(service, '2026-13', { stripe: null, billed: new Set(), log })).rejects.toThrow(/not a closed month/)
  })
})

describe('previousUsagePeriod', () => {
  it('steps back one month, across a year', () => {
    expect(previousUsagePeriod('2026-11')).toBe('2026-10')
    expect(previousUsagePeriod('2027-01')).toBe('2026-12')
  })
})

describe('invoiceLineDescription', () => {
  it('names the kind, the month, the count and the unit price', () => {
    expect(invoiceLineDescription(usageLine('peppol_send', 25), '2026-12')).toBe('Skickade e-fakturor via Peppol, december 2026: 15 st à 1,00 kr')
  })
})
