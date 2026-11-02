/**
 * The bank payment operations (../payment-orders.ts): what the machine doors
 * answer, that a dry run writes nothing and asks no bank, and that signing
 * stays a person's act (the doors only hand out the Betalningar link).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
import { createTableMockSupabase } from '@/tests/helpers'
import {
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))

import {
  paymentOrdersApprove,
  paymentOrdersCancel,
  paymentOrdersGet,
  paymentOrdersList,
  paymentOrdersPrepare,
  paymentOrdersUnapprove,
  paymentsAvailability,
  paymentsSigningLink,
  paymentsUsage,
  paymentsVerification,
  paymentsVerificationStart,
  paymentsPageUrl,
  toOrderOut,
} from '../payment-orders'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const ORDER_A = 'a0000000-0000-4000-8000-00000000000a'
const ORDER_B = 'b0000000-0000-4000-8000-00000000000b'
const INVOICE_A = '10000000-0000-4000-8000-000000000001'
const ACCOUNT = 'ac000000-0000-4000-8000-000000000001'

const noBank = async (): Promise<never> => {
  throw new Error('the operation contacted the bank')
}
const provider = {
  id: 'open_payments',
  isAvailableFor: () => true,
  createPayment: noBank,
  getPaymentState: noBank,
  createSigningBasket: noBank,
  startSigning: noBank,
  pollSigning: noBank,
  cancelPayment: noBank,
  getBankCapabilities: noBank,
  getCompanyVerification: async () => ({ status: 'valid' as const, validUntil: '2027-10-03' }),
  startCompanyVerification: noBank,
} as unknown as PaymentInitiationProvider

function orderRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    supplier_invoice_id: INVOICE_A,
    batch_id: null,
    status: 'draft',
    amount: '737.50',
    currency: 'SEK',
    requested_execution_date: '2026-10-20',
    cash_account_id: ACCOUNT,
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    payee_name: 'Derome Bygg AB',
    payee_source: 'supplier',
    payee_check: 'known',
    reference_type: 'ocr',
    reference: '4400112233',
    end_to_end_id: 'ACC0A',
    provider_status: null,
    provider_error_code: null,
    outcome_unknown_at: null,
    approved_at: null,
    submitted_at: null,
    signed_at: null,
    executed_at: null,
    cancelled_at: null,
    matched_at: null,
    created_at: '2026-10-10T09:00:00Z',
    updated_at: '2026-10-10T09:00:00Z',
    supplier_invoice: { supplier_invoice_number: 'CD3014794407', due_date: '2026-10-20', supplier: { name: 'Derome Bygg AB' } },
    ...overrides,
  }
}

const ACCOUNT_ROW = {
  id: ACCOUNT,
  name: 'Företagskonto',
  ledger_account: '1930',
  iban: 'SE3550000000054910000003',
  currency: 'SEK',
  enabled: true,
  bank_connection: { bank_name: 'SEB' },
}

const INVOICE_ROW = {
  id: INVOICE_A,
  supplier_id: 'sup-1',
  status: 'approved',
  approved_at: '2026-09-29T08:00:00Z',
  due_date: '2099-10-20',
  remaining_amount: 737.5,
  currency: 'SEK',
  is_credit_note: false,
  payment_reference: '4400112233',
  supplier_invoice_number: 'CD3014794407',
  payee_bankgiro: null,
  payee_plusgiro: null,
  payee_clearing: null,
  payee_account: null,
}

const SUPPLIER_ROW = { id: 'sup-1', name: 'Derome Bygg AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null }

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

// The fixtures' execution dates are fixed calendar days, and approval moves a
// date that is no longer a future banking day (bankDayFor). A fixed clock keeps
// them in the future; on the wall clock the approve test broke the day its
// fixture date became today.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  db = createTableMockSupabase({
    company_settings: { data: { org_number: '5566778899', is_sandbox: false } },
    cash_accounts: { data: ACCOUNT_ROW },
    supplier_invoices: { data: [INVOICE_ROW] },
    suppliers: { data: [SUPPLIER_ROW] },
    supplier_payment_batch_items: { data: [] },
    payment_orders: { data: [] },
    payment_order_events: { data: null },
    bankid_identities: { data: null },
  })
  mock.supabase = db.supabase
  ctx = {
    supabase: db.supabase as never,
    companyId: COMPANY,
    userId: 'user-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
  }
})

const run = <I, O>(op: { run: (c: OperationContext, i: I, o: { dryRun: boolean }) => Promise<O> }, input: I, dryRun = false) =>
  op.run(ctx, input, { dryRun })

describe('toOrderOut', () => {
  it('answers qualified ids, a payee label and the invoice behind the order; never a bare id', () => {
    const out = toOrderOut(orderRow(ORDER_A) as never)
    expect(out).toMatchObject({
      payment_order_id: ORDER_A,
      supplier_invoice_id: INVOICE_A,
      payment_order_batch_id: null,
      amount: 737.5,
      payee: { type: 'bankgiro', label: 'BG 5050-1055', name: 'Derome Bygg AB', source: 'supplier', check: 'known' },
      reference: { type: 'ocr', value: '4400112233' },
      outcome_unknown: false,
      supplier_invoice: { supplier_invoice_number: 'CD3014794407', due_date: '2026-10-20', supplier_name: 'Derome Bygg AB' },
    })
    expect(out).not.toHaveProperty('id')
    expect(out).not.toHaveProperty('idempotency_key')
  })

  it('labels every payee type and flags an unknown bank outcome', () => {
    expect(toOrderOut(orderRow(ORDER_A, { payee_type: 'plusgiro', payee_plusgiro: '1234567' }) as never).payee.label).toBe('PG 123456-7')
    expect(
      toOrderOut(orderRow(ORDER_A, { payee_type: 'bank_account', payee_clearing: '3300', payee_account: '1234567' }) as never).payee.label,
    ).toBe('3300 1234567')
    expect(toOrderOut(orderRow(ORDER_A, { payee_type: 'iban', payee_iban: 'SE3550000000054910000003' }) as never).payee.label).toBe(
      'SE3550000000054910000003',
    )
    expect(toOrderOut(orderRow(ORDER_A, { outcome_unknown_at: '2026-10-10T10:00:00Z', supplier_invoice: null }) as never)).toMatchObject({
      outcome_unknown: true,
      supplier_invoice: null,
    })
  })
})

describe('payment-orders.list', () => {
  it('lists newest first with a next cursor when the page is full, filtered by company', async () => {
    db.setTable('payment_orders', { data: [orderRow(ORDER_A), orderRow(ORDER_B)] })
    const result = await run(paymentOrdersList, { status: 'all', limit: 1 })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.payment_orders).toHaveLength(1)
    expect(result.data.payment_orders[0].payment_order_id).toBe(ORDER_A)
    expect(result.data.next_cursor).toEqual(expect.any(String))
    expect(db.findCall('payment_orders', 'eq')).toEqual(['company_id', COMPANY])
  })

  it('open means not closed and not settled; one status is a plain filter', async () => {
    await run(paymentOrdersList, { status: 'open', limit: 50 })
    expect(db.findCall('payment_orders', 'not')).toEqual(['status', 'in', '(rejected,cancelled,failed)'])
    expect(db.findCall('payment_orders', 'is')).toEqual(['supplier_invoice_payment_id', null])
    db.reset()
    await run(paymentOrdersList, { status: 'approved', limit: 50, supplier_invoice_id: INVOICE_A })
    expect(db.findCalls('payment_orders', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'approved'],
      ['supplier_invoice_id', INVOICE_A],
    ])
  })
})

describe('payment-orders.get', () => {
  it('answers the order, or PAYMENT_ORDER_NOT_FOUND', async () => {
    db.setTable('payment_orders', { data: orderRow(ORDER_A) })
    const found = await run(paymentOrdersGet, { payment_order_id: ORDER_A })
    expect(found.ok && !found.dryRun && found.data.payment_order_id).toBe(ORDER_A)
    db.setTable('payment_orders', { data: null })
    const missing = await run(paymentOrdersGet, { payment_order_id: ORDER_B })
    expect(missing).toMatchObject({ ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' })
  })
})

describe('payment-orders.prepare', () => {
  const input = { supplier_invoice_ids: [INVOICE_A], cash_account_id: ACCOUNT }

  it('dry run: answers the lines with payee labels and writes nothing, calls no RPC', async () => {
    const result = await run(paymentOrdersPrepare, input, true)
    if (!result.ok || !result.dryRun) throw new Error('expected a preview')
    expect(result.preview).toMatchObject({
      cash_account_id: ACCOUNT,
      debtor: { bic: 'ESSESESS' },
      total_amount: 737.5,
      currency: 'SEK',
      skipped: [],
    })
    const lines = result.preview.lines as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      supplier_invoice_id: INVOICE_A,
      amount: 737.5,
      payee: { type: 'bankgiro', label: 'BG 5050-1055', source: 'supplier' },
      reference: { type: 'ocr', value: '4400112233' },
    })
    expect(lines[0]).not.toHaveProperty('payee_bankgiro')
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeUndefined()
    expect(db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })

  it('creates drafts through create_payment_orders and answers them with the Betalningar link', async () => {
    db.setTable('rpc:create_payment_orders', { data: { ok: true, orders: [orderRow(ORDER_A, { supplier_invoice: undefined })] } })
    const result = await run(paymentOrdersPrepare, input)
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.created).toBe(true)
    expect(result.data.payment_orders[0]).toMatchObject({ payment_order_id: ORDER_A, status: 'draft', supplier_invoice: null })
    expect(result.data.next.sign_in_app).toBe(paymentsPageUrl([ORDER_A]))
    expect(result.data.next.sign_in_app).toContain(`/payments?orders=${ORDER_A}`)
    const [args] = db.findCall('rpc:create_payment_orders', 'rpc') as [{ p_orders: unknown[] }]
    expect(args.p_orders).toHaveLength(1)
  })

  it('refuses when no provider serves the company, before any read', async () => {
    resetPaymentInitiationProviders()
    const result = await run(paymentOrdersPrepare, input)
    expect(result).toMatchObject({ ok: false, code: 'PAYMENTS_UNAVAILABLE' })
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeUndefined()
  })
})

describe('payment-orders.prepare with skattekonto', () => {
  const TAX_ROW = orderRow(ORDER_A, {
    supplier_invoice_id: null,
    supplier_invoice: undefined,
    amount: 77404,
    payee_name: 'Skatteverket',
    payee_source: 'skatteverket',
    reference: '1655446688087',
    requested_execution_date: '2026-11-11',
  })

  beforeEach(() => {
    db.setTable('companies', { data: { org_number: '554466-8808', entity_type: 'aktiebolag' } })
    db.setTable('skattekonto_transactions', { data: [] })
    db.setTable('agi_declarations', { data: { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null } })
    db.setTable('deadlines', { data: [] })
    db.setTable('rpc:create_skattekonto_payment_order', { data: { ok: true, order: TAX_ROW } })
  })

  it('refuses supplier invoices and skattekonto together, or neither, and a declaration without its period', () => {
    const parse = (input: unknown) => paymentOrdersPrepare.input.safeParse(input).success
    expect(parse({ cash_account_id: ACCOUNT })).toBe(false)
    expect(parse({ cash_account_id: ACCOUNT, supplier_invoice_ids: [INVOICE_A], skattekonto: {} })).toBe(false)
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: { source: 'agi', year: 2026 } })).toBe(false)
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: { amount: 0 } })).toBe(false)
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: {} })).toBe(true)
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: { source: 'agi', year: 2026, month: 10 } })).toBe(true)
  })

  it('dry run: answers the payment to Skatteverket from the AGI and writes nothing', async () => {
    const result = await run(paymentOrdersPrepare, { cash_account_id: ACCOUNT, skattekonto: { source: 'agi', year: 2026, month: 10 } }, true)
    if (!result.ok || !result.dryRun) throw new Error('expected a preview')
    expect(result.preview).toMatchObject({
      amount: 30568,
      payee: { type: 'bankgiro', label: 'BG 5050-1055', name: 'Skatteverket' },
      source: { kind: 'agi', tax_period: '2026-10', declared: 30568 },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()
    expect(db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })

  it('creates the draft and answers it with what it pays and the Betalningar link', async () => {
    const result = await run(paymentOrdersPrepare, {
      cash_account_id: ACCOUNT,
      skattekonto: { source: 'agi', year: 2026, month: 10, amount: 77404 },
    })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.created).toBe(true)
    expect(result.data.payment_orders).toEqual([
      expect.objectContaining({
        payment_order_id: ORDER_A,
        supplier_invoice_id: null,
        amount: 77404,
        payee: expect.objectContaining({ label: 'BG 5050-1055', name: 'Skatteverket', source: 'skatteverket' }),
        reference: { type: 'ocr', value: '1655446688087' },
      }),
    ])
    expect(result.data.skattekonto).toMatchObject({
      source: { kind: 'agi', tax_period: '2026-10', declared: 30568, filed: true },
      replaced_draft_ids: [],
    })
    expect(result.data.next.sign_in_app).toBe(paymentsPageUrl([ORDER_A]))
    const [args] = db.findCall('rpc:create_skattekonto_payment_order', 'rpc') as [Record<string, unknown>]
    expect(args).toMatchObject({ p_amount: 77404, p_cash_account_id: ACCOUNT })
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeUndefined()
  })

  it('takes skattekonto.source due_date with a real day, and answers what the payment consists of (crm#1260)', async () => {
    const parse = (input: unknown) => paymentOrdersPrepare.input.safeParse(input).success
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: { source: 'due_date', due_date: '2026-11-12' } })).toBe(true)
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: { source: 'due_date', due_date: '2026-11-31' } })).toBe(false)
    expect(parse({ cash_account_id: ACCOUNT, skattekonto: { source: 'due_date' } })).toBe(false)
    expect(paymentOrdersPrepare.mcp?.stage?.title?.({ skattekonto: { source: 'due_date', due_date: '2026-11-12' } })).toBe(
      'Förbered bankbetalning till Skatteverket: allt som förfaller 2026-11-12',
    )

    // The company reports no moms here: the October AGI is all that is due on the 12th.
    const result = await run(paymentOrdersPrepare, {
      cash_account_id: ACCOUNT,
      skattekonto: { source: 'due_date', due_date: '2026-11-12' },
    })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.skattekonto).toMatchObject({
      source: { kind: 'agi', tax_period: '2026-10', declared: 30568 },
      combined: { due_date: '2026-11-12', total: 30568, components: [{ source: 'agi', period: '2026-10', amount: 30568 }], excluded: [] },
    })
    expect(paymentOrdersPrepare.output.safeParse(result.data).success).toBe(true)
  })

  it('answers the refusal of a declaration that asks for nothing', async () => {
    db.setTable('agi_declarations', { data: { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: '2026-11-12T00:00:00Z' } })
    const result = await run(paymentOrdersPrepare, { cash_account_id: ACCOUNT, skattekonto: { source: 'agi', year: 2026, month: 10 } })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE', details: { reason: 'already_paid' } })
  })
})

describe('payment-orders.approve / unapprove', () => {
  it('dry run previews the orders and who needs a payee confirmation, without writing', async () => {
    db.setTable('payment_orders', { data: [orderRow(ORDER_A, { payee_check: 'new' })] })
    const result = await run(paymentOrdersApprove, { payment_order_ids: [ORDER_A, ORDER_B] }, true)
    if (!result.ok || !result.dryRun) throw new Error('expected a preview')
    expect(result.preview).toMatchObject({ missing: [ORDER_B], needs_payee_confirmation: [INVOICE_A] })
    expect(db.calls.filter((c) => c.method === 'update')).toEqual([])
  })

  it('approve answers the approved ids and the signing link', async () => {
    db.setTable('payment_orders', { data: [orderRow(ORDER_A)] })
    const result = await run(paymentOrdersApprove, { payment_order_ids: [ORDER_A] })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.approved_payment_order_ids).toEqual([ORDER_A])
    expect(result.data.sign_in_app).toContain('/payments?orders=')
    expect(db.findCall('payment_orders', 'update')).toEqual([expect.objectContaining({ status: 'approved' })])
  })

  it('unapprove answers what went back to draft', async () => {
    db.setTable('payment_orders', { data: [{ id: ORDER_A }] })
    const result = await run(paymentOrdersUnapprove, { payment_order_ids: [ORDER_A] })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.unapproved_payment_order_ids).toEqual([ORDER_A])
    expect(db.findCall('payment_orders', 'update')).toEqual([expect.objectContaining({ status: 'draft' })])
  })
})

describe('payment-orders.cancel', () => {
  it('dry run on a draft says the bank is not asked, and writes nothing', async () => {
    db.setTable('payment_orders', { data: [orderRow(ORDER_A)] })
    const result = await run(paymentOrdersCancel, { payment_order_id: ORDER_A }, true)
    expect(result).toMatchObject({ ok: true, dryRun: true, preview: { payment_order_id: ORDER_A, status: 'draft', at_bank: false, bank_asked: false } })
    expect(db.calls.filter((c) => c.method === 'update')).toEqual([])
  })

  it('dry run on a payment the bank holds says the bank will be asked, and asks nothing yet', async () => {
    db.setTable('payment_orders', { data: [orderRow(ORDER_A, { status: 'accepted', provider_payment_id: 'pay-1', provider_payment_product: 'swedish-giro' })] })
    const result = await run(paymentOrdersCancel, { payment_order_id: ORDER_A }, true)
    expect(result).toMatchObject({ ok: true, dryRun: true, preview: { at_bank: true, bank_asked: true } })
  })

  it('cancels a draft here and answers the new status', async () => {
    db.setTable('payment_orders', { data: [orderRow(ORDER_A)] })
    const result = await run(paymentOrdersCancel, { payment_order_id: ORDER_A })
    expect(result).toMatchObject({ ok: true, data: { payment_order_id: ORDER_A, cancelled: true, status: 'cancelled' } })
  })

  it('answers PAYMENT_ORDER_NOT_FOUND for an unknown order', async () => {
    db.setTable('payment_orders', { data: [] })
    expect(await run(paymentOrdersCancel, { payment_order_id: ORDER_B })).toMatchObject({ ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' })
  })
})

describe('payments.availability', () => {
  it('masks the IBAN and names the account by cash_account_id', async () => {
    db.setTable('cash_accounts', { data: [ACCOUNT_ROW] })
    const result = await run(paymentsAvailability, {})
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data).toMatchObject({ available: true, provider: 'open_payments', signer_known: false })
    expect(result.data.accounts[0]).toMatchObject({ cash_account_id: ACCOUNT, iban: 'SE35 **** 0003', payable: true, reason: null })
    expect(result.data.accounts[0]).not.toHaveProperty('id')
  })
})

describe('payments.usage', () => {
  it('counts the month against the cap and names what remains', async () => {
    db.setTable('payment_orders', { data: [{ cash_account_id: ACCOUNT }, { cash_account_id: ACCOUNT }] })
    const result = await run(paymentsUsage, { period: '2026-10' })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data).toEqual({
      period: '2026-10',
      payments_sent: 2,
      accounts_used: 1,
      included_payments: 10,
      included_accounts: 2,
      cap_payments: 10,
      extra_offered: false,
      billed_above_included: false,
      subscription_required: false,
      unit_price_ore: 200,
      remaining_payments: 8,
      extra_payments: 0,
      extra_accounts: 0,
    })
  })
})

const VERIFIED_ROW = {
  company_id: COMPANY,
  status: 'valid',
  valid_until: '2027-10-03',
  // Fresh at test time: a stored answer under six hours old is served as is.
  checked_at: new Date().toISOString(),
  link_created_at: null,
  link_expires_at: null,
  handed_off_at: null,
  started_by: null,
  updated_at: '2026-10-13T10:00:00.000Z',
}

describe('payments.verification', () => {
  it('answers the stored verification with its state and link expiry, asking the provider only when the record is stale', async () => {
    db.setTable('company_payment_verifications', { data: VERIFIED_ROW })
    const getCompanyVerification = vi.fn()
    registerPaymentInitiationProvider({ ...provider, getCompanyVerification } as PaymentInitiationProvider)
    const result = await run(paymentsVerification, {})
    expect(result).toMatchObject({ ok: true, data: { status: 'valid', valid_until: '2027-10-03', state: 'valid', link_expires_at: null } })
    expect(getCompanyVerification).not.toHaveBeenCalled()
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(paymentsVerification.output.parse(result.data)).toBeTruthy()
  })

  it('starts a form link, with the hand-off to a signatory when asked, and a dry run touches no bank', async () => {
    const startCompanyVerification = vi.fn().mockResolvedValue({ url: 'https://kyc.openbankingplatform.com/?instanceId=abc' })
    registerPaymentInitiationProvider({ ...provider, startCompanyVerification } as PaymentInitiationProvider)
    // What was on file before: an earlier, expired form. The new link decides the state, not this row.
    const earlier = { ...VERIFIED_ROW, status: 'invalid', valid_until: null, link_created_at: '2020-01-01T10:00:00.000Z', link_expires_at: '2020-01-02T10:00:00.000Z', handed_off_at: null }
    db.setTable('company_payment_verifications', [{ data: earlier }, { data: null }])

    expect(await run(paymentsVerificationStart, { handoff: true }, true)).toEqual({ ok: true, dryRun: true, preview: { action: 'start_company_verification', handoff: true } })
    expect(startCompanyVerification).not.toHaveBeenCalled()

    const result = await run(paymentsVerificationStart, { handoff: true })
    expect(result).toMatchObject({ ok: true, data: { url: 'https://kyc.openbankingplatform.com/?instanceId=abc', state: 'awaiting_signatory' } })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.expires_at).toMatch(/Z$/)
    expect(paymentsVerificationStart.output.parse(result.data)).toBeTruthy()
    expect(db.findCall('company_payment_verifications', 'upsert')![0]).toMatchObject({ link_url: 'https://kyc.openbankingplatform.com/?instanceId=abc', handed_off_at: expect.any(String) })
  })
})

describe('payments.signing-link', () => {
  it('counts what waits, reads the verification best-effort and builds the page link', async () => {
    db.setTable('payment_orders', {
      data: [
        { id: ORDER_A, status: 'draft', outcome_unknown_at: null },
        { id: ORDER_B, status: 'approved', outcome_unknown_at: null },
        { id: 'x', status: 'submitted', outcome_unknown_at: '2026-10-10T10:00:00Z' },
      ],
    })
    db.setTable('company_payment_verifications', { data: VERIFIED_ROW })
    const result = await run(paymentsSigningLink, { payment_order_ids: `${ORDER_A},${ORDER_B}` })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data).toMatchObject({
      awaiting_approval: 1,
      awaiting_signature: 1,
      at_bank: 1,
      outcome_unknown: 1,
      verification: { status: 'valid', valid_until: '2027-10-03', state: 'valid', link_expires_at: null },
    })
    expect(result.data.url).toBe(paymentsPageUrl([ORDER_A, ORDER_B]))
    expect(result.data.note).toMatch(/person/)
  })

  it('refuses an id that is not a uuid', async () => {
    expect(await run(paymentsSigningLink, { payment_order_ids: 'nope' })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})
