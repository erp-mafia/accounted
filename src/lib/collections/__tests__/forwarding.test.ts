import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CollectionsCreditNoteRequest,
  CollectionsDirectPaymentRequest,
  CollectionsRevertPaymentRequest,
} from '@accounted/connect-contract'
import { eventBus } from '@/lib/events'
import { caseView, loadCaseById } from '../case'
import { CollectionsError } from '../errors'
import {
  CLOSED_PAID_REACH_MS,
  FORWARD_MAX_ATTEMPTS,
  actOnForwardIssue,
  cappedForwardAmount,
  drainCollectionForwards,
  forwardBackoffMs,
  forwardErrorIsRetryable,
  forwardIssueOf,
  loadForwardIssues,
  withinClosedPaidReach,
} from '../forwarding'
import { openCollectionCase } from '../open-case'
import type { CollectionsAdapter } from '../port'
import { createCaseWorld, INVOICE_ID, MINUTE, type CaseWorld } from './case-fixtures'
import { COMPANY_ID, ADMIN_ID } from './memory-supabase'

vi.mock('../case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('./case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

type Row = Record<string, unknown>

interface Outbox {
  calls: {
    report: CollectionsDirectPaymentRequest[]
    revert: CollectionsRevertPaymentRequest[]
    credit: CollectionsCreditNoteRequest[]
  }
  /** Fail the next provider calls with these errors, in order. */
  failures: Error[]
  finishes: Row[]
  adapter: CollectionsAdapter
  add(row: Partial<Row>): Row
  rows(): Row[]
}

let seq = 0

/**
 * The outbox in memory: claim and finish as the SQL functions behave for
 * one drain (the lease and ordering races are covered by the pg tests), and
 * an adapter that records what reached the provider.
 */
function outbox(world: CaseWorld, caseId: string): Outbox {
  const calls: Outbox['calls'] = { report: [], revert: [], credit: [] }
  const failures: Error[] = []
  const finishes: Row[] = []
  const rows = () => world.db.rows('collection_payment_forwards')
  const nextFailure = () => {
    const failure = failures.shift()
    if (failure) throw failure
  }
  const adapter: CollectionsAdapter = {
    ...world.adapter,
    async registerPayment(ctx, input) {
      calls.report.push(structuredClone(input))
      nextFailure()
      return world.adapter.registerPayment(ctx, input)
    },
    async revertPayment(ctx, input) {
      calls.revert.push(structuredClone(input))
      nextFailure()
      return world.adapter.revertPayment(ctx, input)
    },
    async registerCreditNote(ctx, input) {
      calls.credit.push(structuredClone(input))
      nextFailure()
      return world.adapter.registerCreditNote(ctx, input)
    },
  }

  world.db.rpcs.set('claim_collection_forwards', (args) => {
    const due = rows().filter(
      (r) =>
        (r.status === 'pending' || r.status === 'revert_pending') &&
        !r.lease_token &&
        (!r.next_attempt_at || Date.parse(String(r.next_attempt_at)) <= world.clock.now) &&
        (!args.p_company_id || r.company_id === args.p_company_id),
    )
    const heads = new Map<unknown, Row>()
    for (const r of [...due].sort(
      (a, b) => Number(b.status === 'revert_pending') - Number(a.status === 'revert_pending') || Number(a.seq) - Number(b.seq),
    )) {
      if (!heads.has(r.case_id)) heads.set(r.case_id, r)
    }
    const claimed = [...heads.values()].slice(0, Number(args.p_limit))
    for (const r of claimed) {
      r.lease_token = randomUUID()
      r.attempts = Number(r.attempts) + 1
    }
    return claimed.map((r) => ({ ...r }))
  })
  world.db.rpcs.set('finish_collection_forward', (args) => {
    finishes.push(args)
    const r = rows().find((x) => x.id === args.p_forward_id)
    if (!r || r.lease_token !== args.p_lease_token) return 'lease_lost'
    r.lease_token = null
    switch (args.p_result) {
      case 'reported':
        Object.assign(r, {
          status: 'forwarded',
          provider_ref: args.p_provider_ref,
          sent_amount: args.p_sent_amount,
          ignored_amount: args.p_ignored_amount,
          forwarded_at: new Date(world.clock.now).toISOString(),
          last_error: null,
        })
        break
      case 'reverted':
        Object.assign(r, { status: 'reverted', reverted_at: new Date(world.clock.now).toISOString() })
        break
      case 'retry':
        Object.assign(r, { next_attempt_at: args.p_retry_at, last_error: args.p_error })
        break
      case 'failed':
        Object.assign(r, { status: 'failed', last_error: args.p_error })
        break
      default:
        Object.assign(r, { status: 'skipped', last_error: args.p_error, ignored_amount: args.p_ignored_amount ?? r.ignored_amount })
    }
    return r.status
  })

  return {
    calls,
    failures,
    finishes,
    adapter,
    rows,
    add(row) {
      const full: Row = {
        id: randomUUID(),
        company_id: COMPANY_ID,
        case_id: caseId,
        kind: 'payment',
        invoice_payment_id: randomUUID(),
        credit_invoice_id: null,
        amount: 500,
        payment_date: '2026-10-05',
        status: 'pending',
        attempts: 0,
        next_attempt_at: null,
        lease_token: null,
        last_error: null,
        request_amount: null,
        sent_amount: null,
        ignored_amount: null,
        forwarded_at: null,
        attention_resolved_at: null,
        seq: seq++,
        ...row,
      }
      world.db.seed('collection_payment_forwards', [full])
      // The stored object, so the tests see what the drain wrote.
      return rows().find((r) => r.id === full.id)!
    },
  }
}

async function registeredCase(world: CaseWorld) {
  const outcome = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!outcome.ok || outcome.dryRun) throw new Error('expected a case')
  expect(outcome.case.submission_status).toBe('registered')
  return outcome.case
}

async function drain(world: CaseWorld, box: Outbox) {
  return drainCollectionForwards({ db: world.db.client, now: world.now, adapterFor: () => box.adapter })
}

describe('drainCollectionForwards: reports', () => {
  it('reports a payment once, keyed by the forward row, with the payment row id as its reference, and moves the remaining principal', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    expect(opened.outstanding_principal).toBe(1250)
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 400 })

    const summary = await drain(world, box)
    expect(summary).toMatchObject({ claimed: 1, reported: 1, failed: 0 })
    expect(box.calls.report).toEqual([
      {
        idempotencyKey: row.id,
        caseRef: opened.provider_case_ref,
        paymentRef: row.invoice_payment_id,
        date: '2026-10-05',
        amount: 400,
        description: null,
      },
    ])
    expect(row).toMatchObject({ status: 'forwarded', sent_amount: 400, ignored_amount: 0, request_amount: 400 })
    expect((await loadCaseById(world.db.client, COMPANY_ID, opened.id))!.outstanding_principal).toBe(850)
    const events = world.db.rows('collection_case_events').filter((e) => e.kind === 'payment_forwarded')
    expect(events).toMatchObject([{ label: 'reported', amount: 400, provider_event_ref: `forward:${row.id}:reported` }])

    // Nothing left: a second run sends nothing.
    expect(await drain(world, box)).toMatchObject({ claimed: 0 })
    expect(box.calls.report).toHaveLength(1)
  })

  it('caps a report at the remaining principal and records the rest for a person', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 1500 })

    await drain(world, box)
    expect(box.calls.report[0]!.amount).toBe(1250)
    expect(row).toMatchObject({ status: 'forwarded', sent_amount: 1250, ignored_amount: 250 })
    expect((await loadCaseById(world.db.client, COMPANY_ID, opened.id))!.outstanding_principal).toBe(0)
    const excess = world.db.rows('collection_case_events').filter((e) => e.label === 'excess')
    expect(excess).toMatchObject([{ kind: 'payment_forwarded', amount: 250 }])
    expect(forwardIssueOf(row as never)).toMatchObject({ issue: 'excess', ignoredAmount: 250, amount: 1500 })
  })

  it('sends nothing when the provider claims nothing more, and hands the whole amount to a person', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    world.db.rows('collection_cases').find((c) => c.id === opened.id)!.outstanding_principal = 0
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 300 })

    expect(await drain(world, box)).toMatchObject({ skipped: 1 })
    expect(box.calls.report).toEqual([])
    expect(row).toMatchObject({ status: 'skipped', ignored_amount: 300, last_error: 'above_remaining_principal' })
  })

  it('records the part the provider itself ignored', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 200 })
    box.adapter.registerPayment = async (_ctx, input) => {
      box.calls.report.push(input)
      return { accepted: true, providerRef: 'p-9', ignoredAmount: 50 }
    }

    await drain(world, box)
    expect(row).toMatchObject({ status: 'forwarded', sent_amount: 150, ignored_amount: 50, provider_ref: 'p-9' })
  })

  it('reports a credit note with the credit note id as its reference', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const creditId = randomUUID()
    const row = box.add({ kind: 'credit_note', invoice_payment_id: null, credit_invoice_id: creditId, amount: 250 })

    await drain(world, box)
    expect(box.calls.credit).toEqual([
      { idempotencyKey: row.id, caseRef: opened.provider_case_ref, creditRef: creditId, date: '2026-10-05', amount: 250 },
    ])
    expect(row).toMatchObject({ status: 'forwarded', sent_amount: 250 })
    expect(world.db.rows('collection_case_events').filter((e) => e.kind === 'credit_forwarded')).toMatchObject([{ label: 'credit' }])
  })

  it('repeats the first request body on a retry even if the remaining principal moved meanwhile', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 1500 })
    box.failures.push(new CollectionsError('timeout', { code: 'CONNECTOR_TIMEOUT', retryable: true }))

    expect(await drain(world, box)).toMatchObject({ retried: 1 })
    expect(row).toMatchObject({ status: 'pending', request_amount: 1250, last_error: 'CONNECTOR_TIMEOUT' })
    expect(Date.parse(String(row.next_attempt_at))).toBe(world.clock.now + forwardBackoffMs(1))

    world.db.rows('collection_cases').find((c) => c.id === opened.id)!.outstanding_principal = 900
    world.clock.now += 2 * MINUTE
    await drain(world, box)
    expect(box.calls.report.map((r) => [r.idempotencyKey, r.amount])).toEqual([
      [row.id, 1250],
      [row.id, 1250],
    ])
    expect(row.status).toBe('forwarded')
  })
})

describe('drainCollectionForwards: reverts and failures', () => {
  it('drops a removed payment at the provider with its own key and the amount the provider holds', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 500, status: 'revert_pending', sent_amount: 400, forwarded_at: new Date().toISOString() })
    world.db.rows('collection_cases').find((c) => c.id === opened.id)!.outstanding_principal = 850

    expect(await drain(world, box)).toMatchObject({ reverted: 1 })
    expect(box.calls.revert).toEqual([
      {
        idempotencyKey: `${row.id}:revert`,
        caseRef: opened.provider_case_ref,
        paymentRef: row.invoice_payment_id,
        date: '2026-10-05',
        amount: 400,
        description: null,
      },
    ])
    expect(row.status).toBe('reverted')
    expect((await loadCaseById(world.db.client, COMPANY_ID, opened.id))!.outstanding_principal).toBe(1250)
    expect(world.db.rows('collection_case_events').filter((e) => e.kind === 'payment_reverted')).toHaveLength(1)
  })

  it('sends a revert before a report on the same case', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    box.add({ amount: 300 })
    box.add({ amount: 300, status: 'revert_pending', sent_amount: 300, forwarded_at: new Date().toISOString() })
    const order: string[] = []
    const report = box.adapter.registerPayment
    const revert = box.adapter.revertPayment
    box.adapter.registerPayment = async (ctx, input) => (order.push('report'), report(ctx, input))
    box.adapter.revertPayment = async (ctx, input) => (order.push('revert'), revert(ctx, input))

    await drain(world, box)
    expect(order).toEqual(['revert', 'report'])
  })

  it('gives up at once on a refusal and after the last attempt on a retryable failure', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const refused = box.add({ amount: 100 })
    box.failures.push(new CollectionsError('bad', { code: 'CONNECTOR_VALIDATION_FAILED', retryable: false }))
    expect(await drain(world, box)).toMatchObject({ failed: 1 })
    expect(refused).toMatchObject({ status: 'failed', last_error: 'CONNECTOR_VALIDATION_FAILED' })

    const tired = box.add({ amount: 100, attempts: FORWARD_MAX_ATTEMPTS - 1 })
    box.failures.push(new CollectionsError('timeout', { code: 'CONNECTOR_TIMEOUT', retryable: true }))
    expect(await drain(world, box)).toMatchObject({ failed: 1 })
    expect(tired).toMatchObject({ status: 'failed', attempts: FORWARD_MAX_ATTEMPTS })
  })

  it('a provider that does not accept the report is tried again', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const row = box.add({ amount: 100 })
    box.adapter.registerPayment = async () => ({ accepted: false, providerRef: null, ignoredAmount: 0 })
    expect(await drain(world, box)).toMatchObject({ retried: 1 })
    expect(row).toMatchObject({ status: 'pending', last_error: 'provider_not_accepted' })
  })

  it('skips a case the provider closed for another reason than payment, and still reverts on one closed as paid', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const caseRow = world.db.rows('collection_cases').find((c) => c.id === opened.id)!
    Object.assign(caseRow, { is_open: false, closed_at: new Date().toISOString(), stage: 'closed_other', close_reason: 'withdrawn' })
    const box = outbox(world, opened.id)
    const withdrawn = box.add({ amount: 100 })
    expect(await drain(world, box)).toMatchObject({ skipped: 1 })
    expect(withdrawn).toMatchObject({ status: 'skipped', last_error: 'case_closed' })
    expect(box.calls.report).toEqual([])

    Object.assign(caseRow, { stage: 'closed_paid', close_reason: 'paid', closed_at: world.now().toISOString() })
    const revert = box.add({ amount: 100, status: 'revert_pending', sent_amount: 100, forwarded_at: new Date().toISOString() })
    expect(await drain(world, box)).toMatchObject({ reverted: 1 })
    expect(revert.status).toBe('reverted')
  })

  it('leaves a case closed as paid more than 90 days ago alone: a revert there would reopen a claim no new payment follows', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const caseRow = world.db.rows('collection_cases').find((c) => c.id === opened.id)!
    const closedAt = new Date(world.now().getTime() - CLOSED_PAID_REACH_MS - MINUTE)
    Object.assign(caseRow, { is_open: false, closed_at: closedAt.toISOString(), stage: 'closed_paid', close_reason: 'paid' })
    const box = outbox(world, opened.id)
    const revert = box.add({ amount: 100, status: 'revert_pending', sent_amount: 100, forwarded_at: closedAt.toISOString() })
    expect(await drain(world, box)).toMatchObject({ skipped: 1, reverted: 0 })
    expect(revert).toMatchObject({ status: 'skipped', last_error: 'case_closed' })
    expect(box.calls.revert).toEqual([])

    expect(withinClosedPaidReach(new Date(world.now().getTime() - CLOSED_PAID_REACH_MS + MINUTE).toISOString(), world.now())).toBe(true)
    expect(withinClosedPaidReach(null, world.now())).toBe(false)
  })

  it('reads only the named company when asked to', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    box.add({ amount: 100, company_id: '99999999-9999-4999-8999-999999999999' })
    expect(await drainCollectionForwards({ db: world.db.client, now: world.now, adapterFor: () => box.adapter }, { companyId: COMPANY_ID })).toMatchObject({
      claimed: 0,
    })
  })
})

describe('helpers', () => {
  it('caps at the remaining principal, never below zero, and not at all when it is unknown', () => {
    expect(cappedForwardAmount(400, 1250)).toBe(400)
    expect(cappedForwardAmount(1500, 1250)).toBe(1250)
    expect(cappedForwardAmount(100, -5)).toBe(0)
    expect(cappedForwardAmount(100.005, null)).toBe(100.01)
  })

  it('rests 1, 5, 30 minutes, 2 hours, then 12 hours', () => {
    expect([1, 2, 3, 4, 5, 8].map(forwardBackoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 43_200_000])
  })

  it('retries what may have reached the provider and unknown failures, not a refusal', () => {
    expect(forwardErrorIsRetryable(new Error('boom'))).toBe(true)
    expect(forwardErrorIsRetryable(new CollectionsError('x', { code: 'CONNECTOR_PROTOCOL_ERROR', retryable: false }))).toBe(true)
    expect(forwardErrorIsRetryable(new CollectionsError('x', { code: 'COLLECTIONS_UNAVAILABLE', retryable: false }))).toBe(true)
    expect(forwardErrorIsRetryable(new CollectionsError('x', { code: 'CONNECTOR_VALIDATION_FAILED', retryable: false }))).toBe(false)
  })
})

describe('registration seeds the forwards', () => {
  it('records the handover request\'s earlier payments before the case reads as registered', async () => {
    const world = await createCaseWorld({ invoice: { paid_amount: 250, remaining_amount: 1000, status: 'partially_paid' } })
    const paymentId = randomUUID()
    world.db.seed('invoice_payments', [
      { id: paymentId, company_id: COMPANY_ID, invoice_id: INVOICE_ID, payment_date: '2026-09-01', amount: 250, source: 'bank' },
    ])
    const seeded: Row[] = []
    world.db.rpcs.set('seed_collection_forwards', (args) => {
      const caseRow = world.db.rows('collection_cases').find((c) => c.id === args.p_case_id)
      seeded.push({ ...args, statusAtSeed: caseRow?.submission_status })
      return 1
    })
    const outcome = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1000 })
    expect(outcome).toMatchObject({ ok: true, registered: true })
    expect(seeded).toEqual([
      {
        p_case_id: (outcome as { case: { id: string } }).case.id,
        p_payments: [{ paymentRef: paymentId, date: '2026-09-01', amount: 250 }],
        p_credits: [],
        statusAtSeed: 'submitted',
      },
    ])
  })
})

describe('a person and a forward issue', () => {
  it('lists failed, partly ignored and retrying forwards on the case view, and retries or resolves them', async () => {
    const world = await createCaseWorld()
    const opened = await registeredCase(world)
    const box = outbox(world, opened.id)
    const failedReport = box.add({ amount: 100, status: 'failed', attempts: 8, last_error: 'X' })
    const failedRevert = box.add({ amount: 50, status: 'failed', forwarded_at: new Date().toISOString(), last_error: 'Y' })
    const excess = box.add({ amount: 300, status: 'forwarded', forwarded_at: new Date().toISOString(), ignored_amount: 40 })
    box.add({ amount: 20, status: 'pending', attempts: 2, last_error: 'CONNECTOR_TIMEOUT' })
    box.add({ amount: 10, status: 'forwarded', forwarded_at: new Date().toISOString(), ignored_amount: 0 })

    const issues = await loadForwardIssues(world.db.client, COMPANY_ID, INVOICE_ID)
    expect(issues.map((i) => [i.amount, i.issue, i.operation]).sort()).toEqual([
      [100, 'failed', 'report'],
      [20, 'retrying', 'report'],
      [300, 'excess', 'report'],
      [50, 'failed', 'revert'],
    ])
    expect(caseView(opened, [], issues).forwardIssues).toHaveLength(4)

    const act = (forwardId: string, action: 'retry' | 'resolve', invoiceId = INVOICE_ID) =>
      actOnForwardIssue(world.db.client, { companyId: COMPANY_ID, invoiceId, forwardId, action, userId: ADMIN_ID })

    expect(await act(failedReport.id as string, 'retry')).toEqual({ ok: true })
    expect(failedReport).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
    expect(await act(failedRevert.id as string, 'retry')).toEqual({ ok: true })
    expect(failedRevert.status).toBe('revert_pending')
    // An excess cannot be "retried", only marked handled, once.
    expect(await act(excess.id as string, 'retry')).toEqual({ ok: false, code: 'COLLECTION_FORWARD_NOT_ACTIONABLE' })
    expect(await act(excess.id as string, 'resolve')).toEqual({ ok: true })
    expect(excess).toMatchObject({ attention_resolved_by: ADMIN_ID })
    expect(await act(excess.id as string, 'resolve')).toEqual({ ok: false, code: 'COLLECTION_FORWARD_NOT_ACTIONABLE' })

    expect(await act(randomUUID(), 'resolve')).toEqual({ ok: false, code: 'COLLECTION_FORWARD_NOT_FOUND' })
    expect(await act(failedReport.id as string, 'resolve', randomUUID())).toEqual({ ok: false, code: 'COLLECTION_FORWARD_NOT_FOUND' })
  })
})
