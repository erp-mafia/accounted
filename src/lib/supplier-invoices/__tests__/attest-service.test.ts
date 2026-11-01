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

const notifyAttestDecisionSafely = vi.fn()
vi.mock('../attest-decision-notify', () => ({
  notifyAttestDecisionSafely: (...args: unknown[]) => notifyAttestDecisionSafely(...args),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import {
  approveSupplierInvoice,
  loadAttestBlockedInvoiceIds,
  personalAttestCap,
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

/** A door's decision batch (AttestDecisionInput), recording what the service adds. */
const decisionBatch = () => ({ add: vi.fn(), size: 0, flush: vi.fn() })

function setup(options: {
  invoice?: object | null
  updated?: Record<string, unknown> | null
  policy?: Record<string, unknown> | null
  attestations?: Array<Record<string, unknown>> | Array<Array<Record<string, unknown>>>
}) {
  const invoice = options.invoice === undefined ? makeSupplierInvoice({ id: 'inv-1', user_id: CILLA, due_date: FUTURE }) : options.invoice
  const session = createTableMockSupabase({
    // The first read, then the re-read when the marker is not (or not by this call) set.
    supplier_invoices: { data: invoice },
    company_attest_policies: { data: options.policy ?? null },
    company_settings: { data: { accounting_method: 'accrual' } },
    supplier_invoice_attestations: Array.isArray(options.attestations?.[0])
      ? (options.attestations as Array<Array<Record<string, unknown>>>).map((data) => ({ data }))
      : { data: options.attestations ?? [] },
  })
  // The service role: the trail and the attest marker (a session may not write it).
  const writer = createTableMockSupabase({
    supplier_invoices: { data: options.updated === undefined ? (invoice ? { ...invoice, status: 'approved', approved_at: 'now' } : null) : options.updated },
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

  const attested = { ok: true, approved: true, attestation_id: 'att-1', status: 'approved' }

  it('the dashboard attests through the database on the member\'s own session, which names nobody else', async () => {
    const { session, writer, ctx, writerClient } = setup({})
    // The service role still reads who keeps the books.
    vi.mocked(createServiceClient).mockReturnValue(writerClient as never)
    session.setTable('supplier_invoices', [{ data: makeSupplierInvoice({ id: 'inv-1', user_id: CILLA, due_date: FUTURE }) }, { data: { id: 'inv-1', status: 'approved' } }])
    session.setTable('rpc:attest_supplier_invoice', { data: attested })
    const emit = vi.spyOn(eventBus, 'emit')
    const outcome = await approveSupplierInvoice(ctx(CILLA), { invoiceId: 'inv-1', source: 'app' })
    expect(outcome).toMatchObject({ ok: true, data: { approved: true, attestation_id: 'att-1', invoice: { status: 'approved' }, attest: { required: false } } })
    expect(session.findCall('rpc:attest_supplier_invoice', 'rpc')).toEqual([{ p_company_id: 'company-1', p_invoice_id: 'inv-1' }])
    // Nobody writes the marker or the trail past the database's function.
    for (const client of [session, writer]) {
      expect(client.payloads('supplier_invoices', 'update')).toEqual([])
      expect(client.payloads('supplier_invoice_attestations', 'insert')).toEqual([])
    }
    expect(writer.findCalls('rpc:attest_supplier_invoice', 'rpc')).toEqual([])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'supplier_invoice.approved' }))
  })

  it('a service door names the attester, its source and the key it comes through', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    writer.setTable('rpc:attest_supplier_invoice', { data: attested })
    // The key's ceiling rides on the commit actor (every v1 door binds it); the database caps by it with levels on.
    await runWithActor({ type: 'api_key', label: 'Agent', unattendedCommitLimit: 50000 }, () =>
      approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'api', writer: writerClient }),
    )
    expect(writer.findCall('rpc:attest_supplier_invoice', 'rpc')).toEqual([
      { p_company_id: 'company-1', p_invoice_id: 'inv-1', p_user_id: ANNA, p_source: 'api', p_via_key: true, p_key_ceiling: 50000 },
    ])

    // Above the ceiling the key attests nothing, whatever the levels: refused before the database is asked.
    const over = setup({ policy: policyRow() })
    expect(
      await runWithActor({ type: 'api_key', label: 'Agent', unattendedCommitLimit: 5000 }, () =>
        approveSupplierInvoice(over.ctx(ANNA), { invoiceId: 'inv-1', source: 'api', writer: over.writerClient }),
      ),
    ).toMatchObject({ ok: false, code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', details: { attempted: 10000, limit: 5000 } })
    expect(over.writer.findCalls('rpc:attest_supplier_invoice', 'rpc')).toEqual([])

    const link = setup({ policy: policyRow() })
    link.writer.setTable('rpc:attest_supplier_invoice', { data: attested })
    await approveSupplierInvoice(link.ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: link.writerClient })
    expect(link.writer.findCall('rpc:attest_supplier_invoice', 'rpc')).toEqual([
      { p_company_id: 'company-1', p_invoice_id: 'inv-1', p_user_id: ANNA, p_source: 'email_link', p_via_key: false, p_key_ceiling: null },
    ])
  })

  it('tells the registrant once the attest is complete, unless the door sends one mail for several', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    writer.setTable('rpc:attest_supplier_invoice', { data: attested })
    await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: writerClient })
    expect(notifyAttestDecisionSafely).toHaveBeenCalledTimes(1)
    expect(notifyAttestDecisionSafely).toHaveBeenCalledWith(writerClient, 'company-1', ANNA, { invoiceId: 'inv-1', decision: 'approved', comment: null })

    notifyAttestDecisionSafely.mockClear()
    const batch = setup({ policy: policyRow() })
    batch.writer.setTable('rpc:attest_supplier_invoice', { data: attested })
    const decisions = decisionBatch()
    await approveSupplierInvoice(batch.ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: batch.writerClient, decisions })
    expect(notifyAttestDecisionSafely).not.toHaveBeenCalled()
    expect(decisions.add).toHaveBeenCalledWith('company-1', ANNA, { invoiceId: 'inv-1', decision: 'approved', comment: null })

    // An approval that leaves the invoice waiting for the next attester tells nobody yet.
    const first = setup({ policy: policyRow({ mode: 'all' }) })
    first.writer.setTable('rpc:attest_supplier_invoice', { data: { ...attested, approved: false, status: 'registered' } })
    const firstDecisions = decisionBatch()
    await approveSupplierInvoice(first.ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: first.writerClient, decisions: firstDecisions })
    await approveSupplierInvoice(first.ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: first.writerClient })
    expect(notifyAttestDecisionSafely).not.toHaveBeenCalled()
    expect(firstDecisions.add).not.toHaveBeenCalled()
  })

  it('sends the registrant\'s mail after the event, so a slow mail never holds up the event', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    writer.setTable('rpc:attest_supplier_invoice', { data: attested })
    const order: string[] = []
    vi.spyOn(eventBus, 'emit').mockImplementation(async () => {
      order.push('event')
    })
    notifyAttestDecisionSafely.mockImplementation(async () => {
      order.push('mail')
    })
    await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'email_link', writer: writerClient })
    expect(order).toEqual(['event', 'mail'])
  })

  it('collects the answer the moment the attest is stored, so a read that fails after it loses nobody\'s answer', async () => {
    const { session, writer, ctx, writerClient } = setup({ policy: policyRow() })
    writer.setTable('rpc:attest_supplier_invoice', { data: attested })
    // The reads after the attest (the policy for the progress answer) fail.
    session.setTable('company_attest_policies', { error: { message: 'connection reset' } })
    const decisions = decisionBatch()
    await expect(approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'mcp', writer: writerClient, decisions })).rejects.toBeTruthy()
    expect(decisions.add).toHaveBeenCalledWith('company-1', ANNA, { invoiceId: 'inv-1', decision: 'approved', comment: null })
  })

  it('answers the database\'s refusals in the doors\' codes, and emits nothing', async () => {
    const emit = vi.spyOn(eventBus, 'emit')
    const refusals: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ ok: false, code: 'FORBIDDEN', reason: 'not_member' }, { code: 'FORBIDDEN', details: { reason: 'not_member' }, messageSv: expect.stringMatching(/bokföring/) }],
      [{ ok: false, code: 'ATTEST_NOT_ALLOWED', reason: 'registrant' }, { code: 'ATTEST_NOT_ALLOWED', details: { reason: 'registrant' } }],
      [{ ok: false, code: 'ATTEST_ALREADY_GIVEN' }, { code: 'ATTEST_ALREADY_GIVEN' }],
      [
        { ok: false, code: 'ATTEST_LIMIT_EXCEEDED', reason: 'limit', limit_sek: 10000, amount_sek: 30000 },
        { code: 'ATTEST_LIMIT_EXCEEDED', details: { reason: 'limit', limit_sek: 10000, amount_sek: 30000 } },
      ],
      // Pending when read, attested by someone else under the lock.
      [{ ok: false, code: 'SI_APPROVE_NOT_REGISTERED', current_status: 'approved' }, { code: 'SI_APPROVE_NOT_REGISTERED', details: { reason: 'race' } }],
    ]
    for (const [answer, expected] of refusals) {
      const { writer, ctx, writerClient } = setup({ policy: policyRow() })
      writer.setTable('rpc:attest_supplier_invoice', { data: answer })
      expect(await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'api', writer: writerClient }), String(answer.code)).toMatchObject({
        ok: false,
        ...expected,
      })
    }
    expect(emit).not.toHaveBeenCalled()
  })

  it('answers SI_NOT_FOUND and SI_APPROVE_NOT_REGISTERED before asking the database', async () => {
    const missing = setup({ invoice: null })
    expect(await approveSupplierInvoice(missing.ctx(ANNA), { invoiceId: 'x', source: 'api', writer: missing.writerClient })).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
    const done = setup({ invoice: makeSupplierInvoice({ status: 'approved', approved_at: '2026-10-01T09:00:00Z' }) })
    expect(await approveSupplierInvoice(done.ctx(ANNA), { invoiceId: 'x', source: 'api', writer: done.writerClient })).toMatchObject({
      ok: false,
      code: 'SI_APPROVE_NOT_REGISTERED',
    })
    expect(missing.writer.findCalls('rpc:attest_supplier_invoice', 'rpc')).toEqual([])
    expect(done.writer.findCalls('rpc:attest_supplier_invoice', 'rpc')).toEqual([])
  })

  it('an approval that does not complete the policy says who is left and emits nothing', async () => {
    const mine = { user_id: ANNA, decision: 'approved', decided_at: '2026-10-01T09:00:00Z' }
    const { writer, ctx, writerClient } = setup({ policy: policyRow({ mode: 'all' }), attestations: [mine] })
    writer.setTable('rpc:attest_supplier_invoice', { data: { ok: true, approved: false, attestation_id: 'att-1', status: 'registered' } })
    const emit = vi.spyOn(eventBus, 'emit')
    const outcome = await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'api', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: false, attest: { required: true, satisfied: false, remaining: [BO], approvals_needed: 1 } } })
    expect(emit).not.toHaveBeenCalled()
  })

  it('emits the event of a committed attest even when the invoice cannot be read back', async () => {
    const { session, writer, ctx, writerClient } = setup({})
    session.setTable('supplier_invoices', [{ data: makeSupplierInvoice({ id: 'inv-1', user_id: CILLA, due_date: FUTURE }) }, { error: { message: 'timeout' } }])
    writer.setTable('rpc:attest_supplier_invoice', { data: { ...attested, approved_at: '2026-10-29T10:00:00Z' } })
    const emit = vi.spyOn(eventBus, 'emit')
    const outcome = await approveSupplierInvoice(ctx(CILLA), { invoiceId: 'inv-1', source: 'api', writer: writerClient })
    expect(outcome).toMatchObject({ ok: true, data: { approved: true, invoice: { id: 'inv-1', status: 'approved', approved_at: '2026-10-29T10:00:00Z', approved_by: CILLA } } })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'supplier_invoice.approved' }))
  })

  it('a failed call answers SI_APPROVE_UPDATE_FAILED', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    writer.setTable('rpc:attest_supplier_invoice', { error: { message: 'boom' } })
    expect(await approveSupplierInvoice(ctx(ANNA), { invoiceId: 'inv-1', source: 'api', writer: writerClient })).toMatchObject({
      ok: false,
      code: 'SI_APPROVE_UPDATE_FAILED',
    })
  })

  it('a dry run reads the rules and writes nothing: who is left, and a limit that does not cover', async () => {
    const all = setup({ policy: policyRow({ mode: 'all' }) })
    const outcome = await approveSupplierInvoice(all.ctx(ANNA), { invoiceId: 'inv-1', source: 'api', dryRun: true, writer: all.writerClient })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { attest_required: true, completes_attest: false, attest_remaining_user_ids: [BO], status: 'registered', attest_step: 1 },
    })
    expect(all.writer.findCalls('rpc:attest_supplier_invoice', 'rpc')).toEqual([])

    // Anna attests up to 5 000 kr; the invoice is 10 000 kr and needs one attester.
    const capped = setup({ policy: policyRow() })
    capped.session.setTable('company_attest_limits', { data: [{ user_id: ANNA, max_amount_sek: '5000.00' }] })
    expect(await approveSupplierInvoice(capped.ctx(ANNA), { invoiceId: 'inv-1', source: 'api', dryRun: true, writer: capped.writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_LIMIT_EXCEEDED',
      details: { reason: 'limit', limit_sek: 5000, amount_sek: 10000 },
    })

    const outsider = setup({})
    expect(await approveSupplierInvoice(outsider.ctx('viewer-or-gone'), { invoiceId: 'inv-1', source: 'api', dryRun: true, writer: outsider.writerClient })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })
})

describe('personalAttestCap', () => {
  it("is the person's limit while levels govern the invoice, else nothing", async () => {
    const levels = setup({ policy: policyRow() })
    levels.session.setTable('company_attest_limits', { data: [{ user_id: ANNA, max_amount_sek: 5000 }] })
    expect(await personalAttestCap(levels.session.supabase as unknown as SupabaseClient, 'company-1', ANNA, 'inv-1')).toBe(5000)
    expect(await personalAttestCap(levels.session.supabase as unknown as SupabaseClient, 'company-1', BO, 'inv-1')).toBeNull()

    const plain = setup({ policy: policyRow() })
    expect(await personalAttestCap(plain.session.supabase as unknown as SupabaseClient, 'company-1', ANNA, 'inv-1')).toBeNull()

    const below = setup({ policy: policyRow({ threshold_amount: 50000 }) })
    below.session.setTable('company_attest_limits', { data: [{ user_id: ANNA, max_amount_sek: 5000 }] })
    expect(await personalAttestCap(below.session.supabase as unknown as SupabaseClient, 'company-1', ANNA, 'inv-1')).toBeNull()
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

  it('tells the registrant the invoice will not be paid, with the comment, unless the door sends one mail for several', async () => {
    notifyAttestDecisionSafely.mockClear()
    const { ctx, writerClient } = setup({ policy: policyRow() })
    await rejectSupplierInvoice(ctx(BO), { invoiceId: 'inv-1', comment: '  Fel belopp  ', source: 'app', writer: writerClient })
    expect(notifyAttestDecisionSafely).toHaveBeenCalledWith(writerClient, 'company-1', BO, { invoiceId: 'inv-1', decision: 'rejected', comment: 'Fel belopp' })

    notifyAttestDecisionSafely.mockClear()
    const batch = setup({ policy: policyRow() })
    const decisions = decisionBatch()
    await rejectSupplierInvoice(batch.ctx(BO), { invoiceId: 'inv-1', comment: 'Inte beställt', source: 'email_link', writer: batch.writerClient, decisions })
    expect(decisions.add).toHaveBeenCalledWith('company-1', BO, { invoiceId: 'inv-1', decision: 'rejected', comment: 'Inte beställt' })
    // Without a policy a rejection is no attest answer anyone waits on.
    const unrestricted = setup({ policy: null })
    const none = decisionBatch()
    await rejectSupplierInvoice(unrestricted.ctx(BO), { invoiceId: 'inv-1', source: 'app', writer: unrestricted.writerClient, decisions: none })
    await rejectSupplierInvoice(unrestricted.ctx(BO), { invoiceId: 'inv-1', source: 'app', writer: unrestricted.writerClient })
    expect(notifyAttestDecisionSafely).not.toHaveBeenCalled()
    expect(none.add).not.toHaveBeenCalled()
  })

  it('closes the other attesters\' links before the rejection mail goes out, and still mails when closing them fails', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    let linksClosedAtMail = -1
    notifyAttestDecisionSafely.mockImplementation(async () => {
      linksClosedAtMail = writer.payloads('supplier_invoice_attest_links', 'update').length
    })
    await rejectSupplierInvoice(ctx(BO), { invoiceId: 'inv-1', comment: 'Fel belopp', source: 'app', writer: writerClient })
    expect(linksClosedAtMail).toBe(1)

    notifyAttestDecisionSafely.mockReset()
    const failing = setup({ policy: policyRow() })
    failing.writer.setTable('supplier_invoice_attest_links', { error: { message: 'connection reset' } })
    await expect(rejectSupplierInvoice(failing.ctx(BO), { invoiceId: 'inv-1', source: 'app', writer: failing.writerClient })).rejects.toBeTruthy()
    expect(notifyAttestDecisionSafely).toHaveBeenCalledWith(failing.writerClient, 'company-1', BO, { invoiceId: 'inv-1', decision: 'rejected', comment: null })
  })

  it('collects a stored rejection even when closing its links fails after it', async () => {
    const { writer, ctx, writerClient } = setup({ policy: policyRow() })
    writer.setTable('supplier_invoice_attest_links', { error: { message: 'connection reset' } })
    const decisions = decisionBatch()
    await expect(rejectSupplierInvoice(ctx(BO), { invoiceId: 'inv-1', source: 'email_link', writer: writerClient, decisions })).rejects.toBeTruthy()
    expect(decisions.add).toHaveBeenCalledWith('company-1', BO, { invoiceId: 'inv-1', decision: 'rejected', comment: null })
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
  const base = { enabled: true, threshold_amount: null, mode: 'any' as const, preparer_may_attest: false }

  it('needs an attester when on and refuses someone who may not write', async () => {
    const { ctx, writerClient } = setup({})
    expect(await saveAttestPolicy(ctx(ANNA), { ...base, attesters: [] }, { writer: writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_POLICY_NO_ATTESTERS',
    })
    expect(await saveAttestPolicy(ctx(ANNA), { ...base, attesters: ['stranger'] }, { writer: writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_POLICY_ATTESTER_NOT_MEMBER',
      details: { user_ids: ['stranger'] },
    })
  })

  it('needs two attesters for two steps, and gives limits only to attesters', async () => {
    const { writer, ctx, writerClient } = setup({})
    expect(await saveAttestPolicy(ctx(ANNA), { ...base, attesters: [ANNA], two_step_from_sek: 50000 }, { writer: writerClient })).toMatchObject({
      ok: false,
      code: 'ATTEST_POLICY_TWO_STEP_NEEDS_TWO',
    })
    expect(
      await saveAttestPolicy(ctx(ANNA), { ...base, attesters: [ANNA], limits: [{ user_id: CILLA, max_amount_sek: 1000 }] }, { writer: writerClient }),
    ).toMatchObject({ ok: false, code: 'ATTEST_LIMIT_NOT_ATTESTER', details: { user_ids: [CILLA] } })
    expect(writer.findCalls('rpc:save_company_attest_policy', 'rpc')).toEqual([])
  })

  it('saves the policy and the limits in one call, with who changed them; a dry run writes nothing', async () => {
    const { session, writer, ctx, writerClient } = setup({})
    session.setTable('company_attest_policies', { data: policyRow({ threshold_amount: '5000.00', two_step_from_sek: '50000.00' }) })
    const input = {
      ...base,
      threshold_amount: 5000,
      attesters: [ANNA, ANNA, BO],
      two_step_from_sek: 50000,
      limits: [
        { user_id: ANNA, max_amount_sek: 20000.004 },
        { user_id: BO, max_amount_sek: null },
      ],
    }
    expect(await saveAttestPolicy(ctx(ANNA), input, { writer: writerClient, dryRun: true })).toMatchObject({ ok: true, dryRun: true })
    expect(writer.findCalls('rpc:save_company_attest_policy', 'rpc')).toEqual([])

    const saved = await saveAttestPolicy(ctx(ANNA), input, { writer: writerClient })
    expect(saved).toMatchObject({ ok: true, data: { enabled: true, threshold_amount: 5000, two_step_from_sek: 50000 } })
    expect(writer.findCall('rpc:save_company_attest_policy', 'rpc')).toEqual([
      {
        p_company_id: 'company-1',
        p_enabled: true,
        p_threshold_amount: 5000,
        p_mode: 'any',
        p_attesters: [ANNA, BO],
        p_preparer_may_attest: false,
        p_two_step_from_sek: 50000,
        p_limits: [
          { user_id: ANNA, max_amount_sek: 20000 },
          { user_id: BO, max_amount_sek: null },
        ],
        p_updated_by: ANNA,
      },
    ])
  })

  it('leaves two steps and the limits as they are when the caller leaves them out', async () => {
    const { session, writer, ctx, writerClient } = setup({ policy: policyRow({ two_step_from_sek: '80000.00' }) })
    session.setTable('company_attest_policies', { data: policyRow({ two_step_from_sek: '80000.00' }) })
    await saveAttestPolicy(ctx(ANNA), { ...base, attesters: [ANNA, BO] }, { writer: writerClient })
    expect(writer.findCall('rpc:save_company_attest_policy', 'rpc')?.[0]).toMatchObject({ p_two_step_from_sek: 80000, p_limits: null })
  })

  it('answers FORBIDDEN when the RLS policies refuse a session that is no owner or admin', async () => {
    const { writer, ctx, writerClient } = setup({})
    writer.setTable('rpc:save_company_attest_policy', { error: { code: '42501', message: 'new row violates row-level security policy' } })
    expect(await saveAttestPolicy(ctx(ANNA), { ...base, attesters: [ANNA] }, { writer: writerClient })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})
