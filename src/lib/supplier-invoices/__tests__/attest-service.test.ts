import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => {
    throw new Error('the tests pass a writer')
  }),
}))

import {
  approveSupplierInvoice,
  loadAttestBlockedInvoiceIds,
  rejectSupplierInvoice,
  saveAttestPolicy,
} from '../attest-service'
import { loadCompanyAttestsSupplierInvoices } from '../attest-policy-read'

const ANNA = 'anna'
const BO = 'bo'
const CILLA = 'cilla'
const log = createLogger('test')
const FUTURE = '2999-01-01'

const policyRow = (overrides: Record<string, unknown> = {}) => ({
  company_id: 'company-1',
  enabled: true,
  threshold_amount: null,
  mode: 'any',
  attesters: [ANNA, BO],
  preparer_may_attest: false,
  updated_by: ANNA,
  updated_at: '2026-10-14T09:00:00Z',
  ...overrides,
})

const members = { data: [ANNA, BO, CILLA].map((user_id) => ({ user_id, role: 'member' })) }

function setup(options: {
  invoice?: object | null
  updated?: Record<string, unknown> | null
  policy?: Record<string, unknown> | null
  attestations?: Array<Record<string, unknown>> | Array<Array<Record<string, unknown>>>
}) {
  const invoice = options.invoice === undefined ? makeSupplierInvoice({ id: 'inv-1', user_id: CILLA, due_date: FUTURE }) : options.invoice
  const session = createTableMockSupabase({
    supplier_invoices: [
      { data: invoice },
      { data: options.updated === undefined ? (invoice ? { ...invoice, status: 'approved', approved_at: 'now' } : null) : options.updated },
    ],
    company_attest_policies: { data: options.policy ?? null },
    company_settings: { data: { accounting_method: 'accrual' } },
    supplier_invoice_attestations: Array.isArray(options.attestations?.[0])
      ? (options.attestations as Array<Array<Record<string, unknown>>>).map((data) => ({ data }))
      : { data: options.attestations ?? [] },
  })
  const writer = createTableMockSupabase({
    company_members: members,
    supplier_invoice_attestations: { data: { id: 'att-1' } },
    supplier_invoice_attest_links: { data: null },
  })
  const ctx = (userId: string) => ({ supabase: session.supabase as unknown as SupabaseClient, companyId: 'company-1', userId, log })
  return { session, writer, ctx, writerClient: writer.supabase as unknown as SupabaseClient }
}

describe('approveSupplierInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('without a policy approves as before, records the trail and sets approved_by', async () => {
    const { session, writer, ctx, writerClient } = setup({})
    const emit = vi.spyOn(eventBus, 'emit')
    const outcome = await approveSupplierInvoice(ctx(CILLA), { invoiceId: 'inv-1', source: 'app', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: true, attestation_id: 'att-1', attest: { required: false } } })
    const update = session.payloads('supplier_invoices', 'update')[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'approved', approved_by: CILLA })
    expect(update.approved_at).toEqual(expect.any(String))
    expect(writer.payloads('supplier_invoice_attestations', 'insert')[0]).toMatchObject({ decision: 'approved', source: 'app', user_id: CILLA })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'supplier_invoice.approved' }))
  })

  it('answers SI_NOT_FOUND and SI_APPROVE_NOT_REGISTERED before any rule', async () => {
    const missing = setup({ invoice: null })
    expect(await approveSupplierInvoice(missing.ctx(ANNA), { invoiceId: 'x', source: 'app', writer: missing.writerClient })).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
    const done = setup({ invoice: makeSupplierInvoice({ status: 'approved', approved_at: '2026-10-01T09:00:00Z' }) })
    expect(await approveSupplierInvoice(done.ctx(ANNA), { invoiceId: 'x', source: 'app', writer: done.writerClient })).toMatchObject({
      ok: false,
      code: 'SI_APPROVE_NOT_REGISTERED',
    })
  })

  it('refuses the registrant and a non-attester under the policy, writing nothing', async () => {
    const registrant = setup({ policy: policyRow(), invoice: makeSupplierInvoice({ user_id: ANNA, due_date: FUTURE }) })
    expect(await approveSupplierInvoice(registrant.ctx(ANNA), { invoiceId: 'inv-1', source: 'app', writer: registrant.writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_NOT_ALLOWED',
      details: { reason: 'registrant' },
    })
    expect(registrant.session.payloads('supplier_invoices', 'update')).toEqual([])
    expect(registrant.writer.payloads('supplier_invoice_attestations', 'insert')).toEqual([])

    const outsider = setup({ policy: policyRow() })
    expect(await approveSupplierInvoice(outsider.ctx(CILLA), { invoiceId: 'inv-1', source: 'app', writer: outsider.writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_NOT_ALLOWED',
      details: { reason: 'not_attester' },
    })
  })

  it('any: the first attester attests the invoice', async () => {
    const { session, writer, ctx, writerClient } = setup({ policy: policyRow() })
    const outcome = await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: true } })
    expect(writer.payloads('supplier_invoice_attestations', 'insert')[0]).toMatchObject({ source: 'email_link', user_id: ANNA })
    expect(session.payloads('supplier_invoices', 'update')[0]).toMatchObject({ approved_by: ANNA })
  })

  it('all: the first approval is recorded and the invoice waits for the rest', async () => {
    // The round read back after the insert holds Anna's approval.
    const mine = { user_id: ANNA, decision: 'approved', decided_at: '2026-10-01T09:00:00Z' }
    const { session, ctx, writerClient } = setup({ policy: policyRow({ mode: 'all' }), attestations: [[], [mine]] })
    const outcome = await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'app', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: false, attest: { required: true, satisfied: false, remaining: [BO] } } })
    expect(session.payloads('supplier_invoices', 'update')).toEqual([])
  })

  it('all: the last approval sets approved_at', async () => {
    const earlier = { user_id: ANNA, decision: 'approved', decided_at: '2026-10-01T09:00:00Z' }
    const { session, ctx, writerClient } = setup({ policy: policyRow({ mode: 'all' }), attestations: [earlier] })
    const outcome = await approveSupplierInvoice(ctx(BO), { invoiceId: 'inv-1', source: 'app', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: true } })
    expect(session.payloads('supplier_invoices', 'update')[0]).toMatchObject({ approved_by: BO })
  })

  it('all: an approval that lands while another completes the round still sets the marker', async () => {
    // Read before the insert: nobody yet. Read after it: both.
    const both = [
      { user_id: BO, decision: 'approved', decided_at: '2026-10-01T09:00:00Z' },
      { user_id: ANNA, decision: 'approved', decided_at: '2026-10-01T09:00:01Z' },
    ]
    const { session, ctx, writerClient } = setup({ policy: policyRow({ mode: 'all' }), attestations: [[], both] })
    const outcome = await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'app', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: true } })
    expect(session.payloads('supplier_invoices', 'update')).toHaveLength(1)
  })

  it('all: refuses a second approval by the same attester in the round', async () => {
    const earlier = { user_id: ANNA, decision: 'approved', decided_at: '2026-10-01T09:00:00Z' }
    const { ctx, writerClient } = setup({ policy: policyRow({ mode: 'all' }), attestations: [earlier] })
    expect(await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'app', writer: writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_ALREADY_GIVEN',
    })
  })

  it('without a policy: a lost race answers SI_APPROVE_NOT_REGISTERED and emits nothing', async () => {
    const { ctx, writerClient, writer } = setup({ updated: null })
    const emit = vi.spyOn(eventBus, 'emit')
    expect(await approveSupplierInvoice(ctx(CILLA), { invoiceId: 'inv-1', source: 'app', writer: writerClient })).toMatchObject({
      ok: false,
      code: 'SI_APPROVE_NOT_REGISTERED',
      details: { reason: 'race' },
    })
    expect(emit).not.toHaveBeenCalled()
    expect(writer.payloads('supplier_invoice_attestations', 'insert')).toEqual([])
  })

  it('keeps an overdue invoice overdue when it is still late', async () => {
    const overdue = makeSupplierInvoice({ status: 'overdue', due_date: '2000-01-01', remaining_amount: 1000 })
    const { session, ctx, writerClient } = setup({ invoice: overdue })
    await approveSupplierInvoice(ctx(CILLA), { invoiceId: 'inv-1', source: 'app', writer: writerClient })
    expect(session.payloads('supplier_invoices', 'update')[0]).toMatchObject({ status: 'overdue' })
  })

  it('a dry run writes nothing and says whether the approval completes the attest', async () => {
    const { session, writer, ctx, writerClient } = setup({ policy: policyRow({ mode: 'all' }) })
    const outcome = await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'api', dryRun: true, writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { attest_required: true, completes_attest: false, attest_remaining_user_ids: [BO], status: 'registered' } })
    expect(session.payloads('supplier_invoices', 'update')).toEqual([])
    expect(writer.payloads('supplier_invoice_attestations', 'insert')).toEqual([])
  })
})

describe('rejectSupplierInvoice', () => {
  it('records the rejection with its comment and ends the round: the open links stop working', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    const outcome = await rejectSupplierInvoice(ctx(BO), { invoiceId: 'inv-1', comment: '  Fel belopp  ', source: 'app', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { attestation_id: 'att-1', status: 'registered' } })
    expect(writer.payloads('supplier_invoice_attestations', 'insert')[0]).toMatchObject({ decision: 'rejected', comment: 'Fel belopp', user_id: BO })
    expect(writer.payloads('supplier_invoice_attest_links', 'update')[0]).toMatchObject({ consumed_at: expect.any(String) })
  })

  it('refuses an invoice that does not wait for attest, and someone the policy does not let decide', async () => {
    const done = setup({ invoice: makeSupplierInvoice({ status: 'approved', approved_at: '2026-10-01T09:00:00Z' }), policy: policyRow() })
    expect(await rejectSupplierInvoice(done.ctx(BO), { invoiceId: 'inv-1', source: 'app', writer: done.writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_NOT_PENDING',
    })
    const outsider = setup({ policy: policyRow() })
    expect(await rejectSupplierInvoice(outsider.ctx(CILLA), { invoiceId: 'inv-1', source: 'app', writer: outsider.writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_NOT_ALLOWED',
    })
  })
})

describe('loadAttestBlockedInvoiceIds', () => {
  it('reads no invoice when the policy is off', async () => {
    const mock = createTableMockSupabase({ company_attest_policies: { data: null } })
    expect(await loadAttestBlockedInvoiceIds(mock.supabase as unknown as SupabaseClient, 'company-1', ['a'])).toEqual(new Set())
    expect(mock.tables()).not.toContain('supplier_invoices')
  })

  it('blocks the unattested invoices the policy requires attest for', async () => {
    const mock = createTableMockSupabase({
      company_attest_policies: { data: policyRow({ threshold_amount: 5000 }) },
      company_settings: { data: { accounting_method: 'accrual' } },
      supplier_invoices: {
        data: [
          { id: 'big', user_id: CILLA, approved_at: null, is_credit_note: false, currency: 'SEK', total: 6000, total_sek: null, exchange_rate: null },
          { id: 'small', user_id: CILLA, approved_at: null, is_credit_note: false, currency: 'SEK', total: 100, total_sek: null, exchange_rate: null },
          { id: 'attested', user_id: CILLA, approved_at: '2026-10-01T09:00:00Z', is_credit_note: false, currency: 'SEK', total: 6000, total_sek: null, exchange_rate: null },
        ],
      },
    })
    expect(await loadAttestBlockedInvoiceIds(mock.supabase as unknown as SupabaseClient, 'company-1', ['big', 'small', 'attested'])).toEqual(new Set(['big']))
  })

  it('throws when it cannot read the policy: payment must not read "no attest needed" from an error', async () => {
    const mock = createTableMockSupabase({ company_attest_policies: { error: { message: 'boom' } } })
    await expect(loadAttestBlockedInvoiceIds(mock.supabase as unknown as SupabaseClient, 'company-1', ['a'])).rejects.toBeTruthy()
  })
})

// crm#1141: the payment paths' unattested warning asks this, the one rule.
describe('loadCompanyAttestsSupplierInvoices', () => {
  it('kontantmetoden has no attest step; faktureringsmetoden and a company without a setting attest', async () => {
    for (const [method, attests] of [['cash', false], ['accrual', true], [null, true]] as const) {
      const mock = createTableMockSupabase({ company_settings: { data: method === null ? null : { accounting_method: method } } })
      expect(await loadCompanyAttestsSupplierInvoices(mock.supabase as unknown as SupabaseClient, 'company-1'), String(method)).toBe(attests)
      expect(mock.findCall('company_settings', 'eq')).toEqual(['company_id', 'company-1'])
    }
  })

  it('a failed read answers true: the warning it decides never blocks, so it stays', async () => {
    const mock = createTableMockSupabase({ company_settings: { error: { message: 'boom' } } })
    expect(await loadCompanyAttestsSupplierInvoices(mock.supabase as unknown as SupabaseClient, 'company-1')).toBe(true)
  })
})

describe('saveAttestPolicy', () => {
  it('needs an attester when on and refuses someone who may not write', async () => {
    const { ctx, writerClient } = setup({})
    expect(await saveAttestPolicy(ctx(ANNA), { enabled: true, threshold_amount: null, mode: 'any', attesters: [], preparer_may_attest: false }, { writer: writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_POLICY_NO_ATTESTERS',
    })
    expect(
      await saveAttestPolicy(ctx(ANNA), { enabled: true, threshold_amount: null, mode: 'any', attesters: ['stranger'], preparer_may_attest: false }, { writer: writerClient }),
    ).toMatchObject({ ok: false, code: 'ATTEST_POLICY_ATTESTER_NOT_MEMBER', details: { user_ids: ['stranger'] } })
  })

  it('upserts the policy with who changed it, and a dry run writes nothing', async () => {
    const { writer, ctx, writerClient } = setup({})
    writer.setTable('company_attest_policies', { data: policyRow({ threshold_amount: '5000.00' }) })
    const input = { enabled: true, threshold_amount: 5000, mode: 'any' as const, attesters: [ANNA, ANNA, BO], preparer_may_attest: false }
    const dry = await saveAttestPolicy(ctx(ANNA), input, { writer: writerClient, dryRun: true })
    expect(dry).toMatchObject({ ok: true, dryRun: true })
    expect(writer.payloads('company_attest_policies', 'upsert')).toEqual([])
    const saved = await saveAttestPolicy(ctx(ANNA), input, { writer: writerClient })
    expect(saved).toMatchObject({ ok: true, data: { enabled: true, threshold_amount: 5000 } })
    expect(writer.payloads('company_attest_policies', 'upsert')[0]).toMatchObject({ attesters: [ANNA, BO], updated_by: ANNA, company_id: 'company-1' })
  })
})
