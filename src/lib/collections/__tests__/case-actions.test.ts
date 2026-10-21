import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionsCaseActionRequest } from '@accounted/connect-contract'
import { eventBus } from '@/lib/events'
import { handOverInvoice, runCaseAction } from '../case-actions'
import { openCollectionCase } from '../open-case'
import { refreshCase } from '../invoice-collection'
import { loadOpenCaseForInvoice } from '../case'
import { CollectionsError } from '../errors'
import type { CollectionsAdapter } from '../port'
import { encodeFakeCaseRef } from '../adapters/fake'
import { CONNECTION_ID, createCaseWorld, ENV_OFF, INVOICE_ID, MINUTE, OPENED_AT, type CaseWorld } from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

vi.mock('../case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('./case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

const updates: Array<{ type: string; stage: string; closeReason: string | null; userId: string }> = []

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  updates.length = 0
  eventBus.on('collection.case_updated', async (p) => {
    updates.push({ type: 'updated', stage: p.stage, closeReason: p.closeReason, userId: p.userId })
  })
  eventBus.on('collection.case_closed', async (p) => {
    updates.push({ type: 'closed', stage: p.stage, closeReason: p.closeReason, userId: p.userId })
  })
})

/** A world with a registered case, `minutes` fake minutes after the handover, re-read from the provider. */
async function worldWithCase(minutes: number, options: { actions?: CollectionsCaseActionRequest[] } = {}) {
  const world = await createCaseWorld()
  const sent: CollectionsCaseActionRequest[] = options.actions ?? []
  const adapter: CollectionsAdapter = {
    ...world.adapter,
    async caseAction(ctx, input) {
      sent.push(input)
      return world.fake.caseAction(ctx, input)
    },
  }
  const opened = await openCollectionCase(world.deps({ adapterFor: () => adapter }), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!opened.ok || opened.dryRun) throw new Error('expected a case')
  world.clock.now = OPENED_AT + minutes * MINUTE
  await refreshCase({ db: world.db.client, adapterFor: () => adapter, now: world.now }, opened.case)
  return { world, adapter, sent, deps: (o: Parameters<CaseWorld['deps']>[0] = {}) => world.deps({ adapterFor: () => adapter, ...o }) }
}

/** A world where the provider only delivered the invoice and watches it: its claim waits for an explicit start. */
async function worldWithDeliveredClaim() {
  const world = await createCaseWorld()
  const sent: CollectionsCaseActionRequest[] = []
  const adapter: CollectionsAdapter = {
    ...world.adapter,
    async caseAction(ctx, input) {
      sent.push(input)
      return world.fake.caseAction(ctx, input)
    },
  }
  const at = new Date(OPENED_AT).toISOString()
  world.db.seed('collection_cases', [
    {
      id: 'case-watch',
      company_id: COMPANY_ID,
      invoice_id: INVOICE_ID,
      connection_id: CONNECTION_ID,
      origin: 'distribution',
      start_step: 'invoice',
      submission_status: 'registered',
      submission_request: null,
      submission_attempts: 1,
      provider_case_ref: encodeFakeCaseRef({ step: 'invoice', openedAt: OPENED_AT, claimAmount: 1250, claimRemaining: 1250, invoiceRef: INVOICE_ID }),
      provider_case_number: null,
      parent_case_ref: null,
      stage: 'invoice_sent',
      decision_kind: null,
      is_open: true,
      close_reason: null,
      actions: ['start', 'withdraw'],
      claim_amount: 1250,
      outstanding_principal: 1250,
      outstanding_total: 1250,
      bank_check: {},
      opened_by: ADMIN_ID,
      opened_at: at,
      closed_at: null,
      last_synced_at: null,
      sync_error: null,
      paused_by_sweep: false,
      last_bank_checked_at: null,
      created_at: at,
      updated_at: at,
    },
  ])
  world.clock.now += 2 * MINUTE
  return { world, sent, deps: (o: Parameters<CaseWorld['deps']>[0] = {}) => world.deps({ adapterFor: () => adapter, ...o }) }
}

describe('runCaseAction', () => {
  it('pauses a case even with every start gate closed: serving an open case is an obligation', async () => {
    const { world, deps, sent } = await worldWithCase(2)
    const outcome = await runCaseAction(deps({ env: ENV_OFF, facts: world.facts({ capability: false }) }), {
      invoiceId: INVOICE_ID,
      action: 'pause',
      until: '2026-10-16',
    })
    expect(outcome).toMatchObject({ ok: true, case: { stage: 'paused' } })
    expect(sent).toMatchObject([{ action: 'pause', until: '2026-10-16', step: null, message: null }])
    const trail = world.db.rows('collection_case_events').filter((e) => e.kind === 'user_action')
    expect(trail).toMatchObject([{ label: 'pause', actor_user_id: ADMIN_ID, company_id: COMPANY_ID }])
    expect(updates).toContainEqual({ type: 'updated', stage: 'paused', closeReason: null, userId: ADMIN_ID })
  })

  it('refuses an approval while the start gates are closed', async () => {
    const { deps } = await worldWithCase(6)
    expect(await runCaseAction(deps({ env: ENV_OFF }), { invoiceId: INVOICE_ID, action: 'approve_step' })).toMatchObject({
      ok: false,
      code: 'COLLECTIONS_DISABLED',
    })
  })

  it('refuses an action the case does not offer', async () => {
    const { deps, sent } = await worldWithCase(2)
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'approve_legal_action' })).toMatchObject({
      ok: false,
      code: 'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE',
      details: { action: 'approve_legal_action', stage: 'reminder' },
    })
    expect(sent).toEqual([])
  })

  it('needs a written reason for a dispute', async () => {
    const { deps } = await worldWithCase(2)
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'dispute', message: 'nej' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_ACTION_MESSAGE_REQUIRED',
      status: 400,
    })
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'dispute', message: 'Kunden säger att varan aldrig kom fram.' })).toMatchObject({
      ok: true,
      case: { stage: 'paused' },
    })
  })

  it('checks the bank before approving the next step, and records when', async () => {
    const { world, deps, sent } = await worldWithCase(6)
    const row = await loadOpenCaseForInvoice(world.db.client, COMPANY_ID, INVOICE_ID)
    expect(row).toMatchObject({ stage: 'awaiting_decision', decision_kind: 'approve_collection_notice' })

    world.db.seed('transactions', [
      {
        id: 'tx-1',
        company_id: COMPANY_ID,
        date: '2026-10-05',
        amount: 1250,
        description: 'Faktura 20261042',
        original_description: null,
        merchant_name: null,
        reference: null,
        potential_invoice_id: null,
        is_ignored: false,
        invoice_id: null,
        supplier_invoice_id: null,
        journal_entry_id: null,
        is_business: null,
      },
    ])
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'approve_step' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_BANK_CANDIDATES',
    })
    expect(sent).toEqual([])

    const outcome = await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'approve_step', dismissedTransactionIds: ['tx-1'] })
    expect(outcome).toMatchObject({ ok: true, case: { stage: 'collection', last_bank_checked_at: world.now().toISOString() } })
    expect(sent).toMatchObject([{ action: 'approve_step', idempotencyKey: `${row!.id}:approve_step:0` }])
    expect(world.db.rows('collection_cases')[0].last_bank_checked_at).toBe(world.now().toISOString())
  })

  it('asks a person to attest an unsynced bank before an escalation; an agent is refused', async () => {
    const { world, deps } = await worldWithCase(6)
    world.db.rows('bank_connections')[0].last_synced_at = '2026-10-01T00:00:00Z'
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'approve_step' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_REQUIRED',
    })
    expect(await runCaseAction(deps({ channel: 'agent' }), { invoiceId: INVOICE_ID, action: 'approve_step' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_BANK_STALE',
    })
    expect(await runCaseAction(deps({ channel: 'agent' }), { invoiceId: INVOICE_ID, action: 'approve_step', attestations: { bank: true } })).toMatchObject({
      ok: false,
      code: 'COLLECTION_ATTESTATION_WEB_ONLY',
    })
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'approve_step', attestations: { bank: true } })).toMatchObject({
      ok: true,
      case: { stage: 'collection' },
    })
  })

  it('gives each decision its own key and repeats the key of a failed one', async () => {
    const { world, deps, sent } = await worldWithCase(2)
    const failing: CollectionsAdapter = {
      ...world.adapter,
      async caseAction(_ctx, input) {
        sent.push(input)
        throw new CollectionsError('down', { code: 'CONNECTOR_UNREACHABLE', retryable: true })
      },
    }
    expect(await runCaseAction(deps({ adapterFor: () => failing }), { invoiceId: INVOICE_ID, action: 'pause' })).toMatchObject({
      ok: false,
      code: 'CONNECTOR_UNREACHABLE',
      status: 503,
    })
    await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'pause' })
    await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'resume' })
    const id = world.db.rows('collection_cases')[0].id
    expect(sent.map((s) => s.idempotencyKey)).toEqual([`${id}:pause:0`, `${id}:pause:0`, `${id}:resume:1`])
  })

  it('withdraws: the case closes, says why, and leaves the invoice status alone', async () => {
    const { world, deps } = await worldWithCase(2)
    const outcome = await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'withdraw' })
    expect(outcome).toMatchObject({ ok: true, case: { is_open: false, close_reason: 'withdrawn', actions: [] } })
    expect(world.db.rows('collection_cases')[0].closed_at).not.toBeNull()
    expect(world.db.rows('invoices')[0].status).toBe('sent')
    expect(updates).toContainEqual({ type: 'closed', stage: 'closed_other', closeReason: 'withdrawn', userId: ADMIN_ID })
    // Nothing open any more.
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'pause' })).toMatchObject({ ok: false, code: 'COLLECTION_CASE_NOT_FOUND', status: 404 })
  })

  it('withdraws free of charge within the free days; after them the person confirms the fee first', async () => {
    const { world, deps, sent } = await worldWithCase(6)
    world.clock.now = OPENED_AT + 15 * 24 * 60 * MINUTE
    const refused = await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'withdraw' })
    expect(refused).toMatchObject({
      ok: false,
      code: 'COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED',
      status: 409,
      details: { free_days: 14, free_until: '2026-10-20T08:00:00.000Z' },
    })
    expect(sent).toEqual([])
    const outcome = await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'withdraw', feeAcknowledged: true })
    expect(outcome).toMatchObject({ ok: true, case: { is_open: false, close_reason: 'withdrawn' } })
    const trail = world.db.rows('collection_case_events').filter((e) => e.kind === 'user_action')
    expect(trail).toMatchObject([{ label: 'withdraw', raw: { withdraw_fee_may_apply: true, withdraw_fee_acknowledged: true } }])
  })

  it('pauses until a date after today and at most 14 days ahead', async () => {
    const { deps, sent } = await worldWithCase(2)
    for (const until of ['2026-10-06', '2026-10-01', '2026-10-21']) {
      expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'pause', until })).toMatchObject({
        ok: false,
        code: 'COLLECTION_PAUSE_UNTIL_INVALID',
        status: 400,
        details: { after: '2026-10-06', latest: '2026-10-20' },
      })
    }
    expect(sent).toEqual([])
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'pause', until: '2026-10-20' })).toMatchObject({ ok: true })
    expect(sent).toMatchObject([{ action: 'pause', until: '2026-10-20' }])
  })

  it('never sends "the customer has paid": the payment is booked instead, or the claim contested', async () => {
    const { world, deps, sent } = await worldWithCase(2)
    Object.assign(world.db.rows('collection_cases')[0], {
      stage: 'awaiting_decision',
      decision_kind: 'debtor_says_paid',
      actions: ['already_paid', 'confirm_not_paid'],
    })
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'already_paid' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_REGISTER_PAYMENT',
      status: 409,
      details: { invoice_id: INVOICE_ID },
    })
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'confirm_not_paid', message: 'kort' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_ACTION_MESSAGE_REQUIRED',
    })
    // "It is not paid" is an escalation: the books and the bank are checked first.
    world.db.rows('invoices')[0].status = 'paid'
    world.db.rows('invoices')[0].paid_amount = 1250
    world.db.rows('invoices')[0].remaining_amount = 0
    expect(
      await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'confirm_not_paid', message: 'Ingen betalning syns i banken.' }),
    ).toMatchObject({ ok: false, code: 'COLLECTION_NOT_ELIGIBLE', details: { blocks: [{ code: 'elig_paid' }] } })
    expect(sent).toEqual([])
  })

  it('does not escalate while the books hold a payment the provider has not heard of', async () => {
    const { world, deps, sent } = await worldWithCase(6)
    Object.assign(world.db.rows('invoices')[0], { status: 'partially_paid', paid_amount: 250, remaining_amount: 1000 })
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'approve_step' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_PAYMENT_NOT_REPORTED',
      details: { remaining: 1000, provider_outstanding: 1250 },
    })
    expect(sent).toEqual([])
    // Pausing and withdrawing still work: they are obligations.
    expect(await runCaseAction(deps(), { invoiceId: INVOICE_ID, action: 'pause' })).toMatchObject({ ok: true })
  })

  it('takes "not a payment of this invoice" from a person in the web UI only', async () => {
    const { deps, sent } = await worldWithCase(6)
    expect(
      await runCaseAction(deps({ channel: 'agent' }), { invoiceId: INVOICE_ID, action: 'approve_step', dismissedTransactionIds: ['tx-1'] }),
    ).toMatchObject({ ok: false, code: 'COLLECTION_ATTESTATION_WEB_ONLY', status: 403 })
    expect(sent).toEqual([])
  })

  it('reads the öresavrundning as no payment: an invoice rounded up to the krona escalates', async () => {
    const world = await createCaseWorld({ invoice: { total: 1249.6, vat_amount: 249.92, remaining_amount: 1249.6 } })
    const opened = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
    expect(opened).toMatchObject({ ok: true, case: { claim_amount: 1250 } })
    world.clock.now = OPENED_AT + 6 * MINUTE
    const row = (await loadOpenCaseForInvoice(world.db.client, COMPANY_ID, INVOICE_ID))!
    await refreshCase({ db: world.db.client, adapterFor: () => world.adapter, now: world.now }, row)
    expect(await runCaseAction(world.deps(), { invoiceId: INVOICE_ID, action: 'approve_step' })).toMatchObject({
      ok: true,
      case: { stage: 'collection' },
    })
  })

  it('takes start only through the handover, which runs the full handover checklist first', async () => {
    const { world, deps, sent } = await worldWithDeliveredClaim()
    // An invoice the handover refuses (a currency the provider does not take): the action route and tool sent start anyway.
    Object.assign(world.db.rows('invoices')[0]!, { currency: 'EUR' })
    for (const channel of ['web', 'agent'] as const) {
      expect(await runCaseAction(deps({ channel }), { invoiceId: INVOICE_ID, action: 'start', step: 'reminder' })).toMatchObject({
        ok: false,
        code: 'COLLECTION_START_VIA_HANDOVER',
        status: 409,
        details: { invoice_id: INVOICE_ID },
      })
    }
    expect(sent).toEqual([])
    expect(await handOverInvoice(deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250, startStep: 'reminder' })).toMatchObject({
      ok: false,
      code: 'COLLECTION_NOT_ELIGIBLE',
    })
    expect(sent).toEqual([])

    Object.assign(world.db.rows('invoices')[0]!, { currency: 'SEK' })
    expect(await handOverInvoice(deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250, startStep: 'reminder' })).toMatchObject({
      ok: true,
      case: { id: 'case-watch', stage: 'reminder' },
    })
    expect(sent).toMatchObject([{ action: 'start', step: 'reminder' }])
  })
})

