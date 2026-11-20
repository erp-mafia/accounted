/**
 * The reconcile of cases under collection (reconcile.ts) over the in-memory
 * database and the fake provider: the expected principal, a difference the
 * books cannot explain (paused when the provider claims more, flagged when
 * less), a pending report that explains one, a forward still settling, the
 * once-only resend of an unacknowledged report, and the forward-row RPC.
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionsAdapter } from '../port'
import { openCollectionCase } from '../open-case'
import {
  FORWARD_SETTLE_MS,
  UNACKNOWLEDGED_RESEND_MS,
  expectedProviderPrincipal,
  reconcileCases,
  reconcileForwardRows,
  type ReconcileDeps,
} from '../reconcile'
import { createCaseWorld, INVOICE_ID, type CaseWorld } from './case-fixtures'
import { COMPANY_ID } from './memory-supabase'

vi.mock('@/lib/collections/case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('./case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

let world: CaseWorld
let caseId: string

const ctx = { companyId: COMPANY_ID, connectionHandle: 'fake-connection-company' }

function deps(adapter: CollectionsAdapter = world.adapter): ReconcileDeps {
  return { db: world.db.client, now: world.now, adapterFor: () => adapter }
}

function caseRow() {
  return world.db.rows('collection_cases').find((r) => r.id === caseId)!
}

function invoice() {
  return world.db.rows('invoices').find((r) => r.id === INVOICE_ID)!
}

/** The books hold a payment the provider never heard of (no payment row, so nothing reports it). */
function ledgerPaid(amount: number) {
  Object.assign(invoice(), { status: 'partially_paid', paid_amount: amount, remaining_amount: 1250 - amount })
}

function forward(row: Record<string, unknown>) {
  const full = {
    id: randomUUID(),
    company_id: COMPANY_ID,
    case_id: caseId,
    kind: 'payment',
    invoice_payment_id: randomUUID(),
    credit_invoice_id: null,
    amount: 250,
    payment_date: '2026-10-05',
    status: 'pending',
    request_amount: null,
    sent_amount: null,
    forwarded_at: null,
    acknowledged_at: null,
    resent_at: null,
    lease_until: null,
    updated_at: new Date(world.clock.now - FORWARD_SETTLE_MS - 1).toISOString(),
    ...row,
  }
  world.db.seed('collection_payment_forwards', [full])
  return world.db.rows('collection_payment_forwards').find((r) => r.id === full.id)!
}

function trail(prefix: string) {
  return world.db
    .rows('collection_case_events')
    .filter((e) => e.case_id === caseId && typeof e.provider_event_ref === 'string' && (e.provider_event_ref as string).startsWith(prefix))
}

beforeEach(async () => {
  vi.clearAllMocks()
  world = await createCaseWorld()
  const opened = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!opened.ok || opened.dryRun) throw new Error('expected a case')
  caseId = opened.case.id
  world.clock.now += 10 * 60_000
})

describe('expectedProviderPrincipal', () => {
  it('adds reports not sent yet, and takes off removed payments the provider holds and what it collected itself', () => {
    expect(expectedProviderPrincipal({ ledgerRemaining: 1000, forwards: [], collectedUnbooked: 0 })).toBe(1000)
    expect(
      expectedProviderPrincipal({
        ledgerRemaining: 700,
        forwards: [
          { status: 'pending', amount: 300, request_amount: null, sent_amount: null, forwarded_at: null },
          { status: 'failed', amount: 100, request_amount: 80, sent_amount: null, forwarded_at: null },
          { status: 'revert_pending', amount: 200, request_amount: 200, sent_amount: 150, forwarded_at: '2026-10-01T00:00:00Z' },
          { status: 'forwarded', amount: 50, request_amount: 50, sent_amount: 50, forwarded_at: '2026-10-01T00:00:00Z' },
          { status: 'skipped', amount: 999, request_amount: null, sent_amount: null, forwarded_at: null },
        ],
        collectedUnbooked: 30,
      }),
    ).toBe(700 + 300 + 80 - 150 - 30)
    expect(expectedProviderPrincipal({ ledgerRemaining: 0, forwards: [], collectedUnbooked: 500 })).toBe(0)
  })
})

describe('reconcileCases', () => {
  it('records agreement and leaves the case alone', async () => {
    const summary = await reconcileCases(deps(), { only: 'all' })
    expect(summary).toMatchObject({ checked: 1, mismatched: 0, paused: 0, complete: true })
    expect(caseRow()).toMatchObject({ outstanding_mismatch: null, paused_by_sweep: false })
    expect(caseRow().last_reconciled_at).toBeTruthy()
  })

  it('pauses a case whose provider claims more than the books, once, and clears the flag when they agree again', async () => {
    ledgerPaid(250)
    const summary = await reconcileCases(deps(), { only: 'all' })
    expect(summary).toMatchObject({ checked: 1, mismatched: 1, paused: 1 })
    expect(caseRow()).toMatchObject({
      outstanding_mismatch: 250,
      outstanding_expected: 1000,
      stage: 'paused',
      paused_by_sweep: true,
      pause_reason: 'outstanding_mismatch',
    })
    expect(trail('reconcile:').map((e) => e.label)).toEqual(['mismatch_paused'])

    // The same difference the next run: no second pause, no second trail row.
    expect(await reconcileCases(deps(), { only: 'mismatched' })).toMatchObject({ checked: 1, mismatched: 1, paused: 0 })
    expect(trail('reconcile:')).toHaveLength(1)

    // The provider hears of the payment: the flag clears, the pause stays for a person to lift.
    await world.adapter.registerPayment(ctx, {
      idempotencyKey: randomUUID(),
      caseRef: caseRow().provider_case_ref as string,
      paymentRef: randomUUID(),
      date: '2026-10-05',
      amount: 250,
      description: null,
    })
    expect(await reconcileCases(deps(), { only: 'mismatched' })).toMatchObject({ checked: 1, mismatched: 0 })
    expect(caseRow()).toMatchObject({ outstanding_mismatch: null, paused_by_sweep: true, pause_reason: 'outstanding_mismatch' })
    expect(trail('reconcile:').map((e) => e.label)).toEqual(['mismatch_paused', 'cleared'])
  })

  it('only flags a provider that claims less than the books', async () => {
    await world.adapter.registerPayment(ctx, {
      idempotencyKey: randomUUID(),
      caseRef: caseRow().provider_case_ref as string,
      paymentRef: randomUUID(),
      date: '2026-10-05',
      amount: 250,
      description: null,
    })
    expect(await reconcileCases(deps(), { only: 'all' })).toMatchObject({ mismatched: 1, paused: 0 })
    expect(caseRow()).toMatchObject({ outstanding_mismatch: -250, paused_by_sweep: false })
    expect(trail('reconcile:').map((e) => e.label)).toEqual(['mismatch'])
  })

  it('counts a report not sent yet, and waits while a forward is settling', async () => {
    ledgerPaid(250)
    const pending = forward({ status: 'pending', amount: 250 })
    expect(await reconcileCases(deps(), { only: 'all' })).toMatchObject({ mismatched: 0 })

    pending.status = 'forwarded'
    pending.forwarded_at = new Date(world.clock.now).toISOString()
    pending.updated_at = new Date(world.clock.now).toISOString()
    const before = caseRow().last_reconciled_at
    expect(await reconcileCases(deps(), { only: 'all' })).toMatchObject({ checked: 1, mismatched: 0 })
    expect(caseRow().last_reconciled_at).toBe(before)
  })

  it('waits for a live lease only, never for one a drain that died left behind', async () => {
    const row = forward({ status: 'skipped', lease_until: new Date(world.clock.now + 60_000).toISOString() })
    await reconcileCases(deps(), { only: 'all' })
    expect(caseRow().last_reconciled_at ?? null).toBeNull()

    row.lease_until = new Date(world.clock.now - 1).toISOString()
    await reconcileCases(deps(), { only: 'all' })
    expect(caseRow().last_reconciled_at).toBe(new Date(world.clock.now).toISOString())
  })

  it('sends an unacknowledged report once more under the same key, once', async () => {
    ledgerPaid(250)
    const calls: Array<{ key: string; amount: number }> = []
    const adapter: CollectionsAdapter = {
      ...world.adapter,
      async registerPayment(c, input) {
        calls.push({ key: input.idempotencyKey, amount: input.amount })
        return world.adapter.registerPayment(c, input)
      },
    }
    const row = forward({
      status: 'forwarded',
      request_amount: 250,
      sent_amount: 250,
      forwarded_at: new Date(world.clock.now - UNACKNOWLEDGED_RESEND_MS - 1).toISOString(),
    })
    // Seeded at the handover (no request of its own): never resent.
    forward({ status: 'forwarded', request_amount: null, sent_amount: 100, amount: 100, forwarded_at: '2026-09-01T00:00:00Z' })

    const summary = await reconcileCases(deps(adapter), { only: 'all' })
    expect(summary.resent).toBe(1)
    expect(calls).toEqual([{ key: row.id, amount: 250 }])
    expect(row.resent_at).toBeTruthy()
    await reconcileCases(deps(adapter), { only: 'all' })
    expect(calls).toHaveLength(1)
  })

  it('stops at the budget and says so', async () => {
    let t = 0
    const summary = await reconcileCases({ ...deps(), clock: () => (t += 1000), budgetMs: 500 }, { only: 'all' })
    expect(summary).toMatchObject({ checked: 0, complete: false })
  })
})

describe('reconcileForwardRows', () => {
  it('reads the counts the SQL reconcile answers', async () => {
    const args: unknown[] = []
    world.db.rpcs.set('reconcile_collection_forwards', (a) => {
      args.push(a)
      return { created_payments: 2, created_credits: 1, reverted: 1, skipped: 3 }
    })
    expect(await reconcileForwardRows(world.db.client, { companyId: COMPANY_ID })).toEqual({
      createdPayments: 2,
      createdCredits: 1,
      reverted: 1,
      skipped: 3,
    })
    expect(args).toEqual([{ p_company_id: COMPANY_ID }])
  })
})
