/**
 * The payment-candidate sweep (bank-sweep.ts) over the in-memory database
 * and the fake provider: a bank row that may pay a case invoice pauses the
 * case once and raises a possible payment; an unrelated row does not; a
 * failed pause is retried; a booked or dismissed row answers it; a person's
 * resume ends the automatic pause. Which rows open_bank_rows holds is
 * tests/pg/bank-row-open-read.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionsAdapter } from '../port'
import {
  SWEEP_PAUSE_RETRY_AFTER_MS,
  dismissPossiblePayment,
  loadPossiblePayments,
  pauseCaseAutomatically,
  sweepCollectionPayments,
  sweepUpkeep,
  type SweepDeps,
} from '../bank-sweep'
import { normalizeCaseRow } from '../case'
import { runCaseAction } from '../case-actions'
import { openCollectionCase } from '../open-case'
import { createCaseWorld, INVOICE_ID, retryableError, type CaseWorld } from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

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

/** A row of open_bank_rows; a booked row the view leaves out goes in the table alone. */
function bankRow(overrides: Record<string, unknown> = {}, table = 'open_bank_rows'): Record<string, unknown> {
  const row = {
    id: randomUUID(),
    company_id: COMPANY_ID,
    date: '2026-10-05',
    amount: 1250,
    description: 'Inbetalning',
    original_description: null,
    merchant_name: null,
    reference: null,
    potential_invoice_id: null,
    is_ignored: false,
    invoice_id: null,
    supplier_invoice_id: null,
    journal_entry_id: null,
    is_business: null,
    ...overrides,
  }
  world.db.seed(table, [row])
  return world.db.rows(table).find((r) => r.id === row.id)!
}

function sweepDeps(adapter: CollectionsAdapter = world.adapter): SweepDeps {
  return { db: world.db.client, now: world.now, adapterFor: () => adapter }
}

function caseRow() {
  return world.db.rows('collection_cases').find((r) => r.id === caseId)!
}

function hits() {
  return world.db.rows('collection_sweep_hits')
}

function events(kind: string) {
  return world.db.rows('collection_case_events').filter((e) => e.case_id === caseId && e.kind === kind)
}

beforeEach(async () => {
  vi.clearAllMocks()
  world = await createCaseWorld()
  const opened = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!opened.ok || opened.dryRun) throw new Error('expected a case')
  caseId = opened.case.id
  world.clock.now += 10 * 60_000
})

describe('sweepCollectionPayments on a bank ingest', () => {
  it('pauses the case once for a row carrying the OCR, and records the possible payment', async () => {
    const row = bankRow({ reference: '20261042', amount: 1250 })
    expect(caseRow().actions).toContain('pause')

    const summary = await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [row.id as string] })
    expect(summary).toMatchObject({ cases: 1, hits: 1, paused: 1, failed: 0 })
    expect(caseRow()).toMatchObject({ stage: 'paused', paused_by_sweep: true, pause_reason: 'possible_payment' })
    expect(hits()).toEqual([
      expect.objectContaining({ case_id: caseId, transaction_id: row.id, reason: 'reference', status: 'open', pause_state: 'paused' }),
    ])
    expect(events('possible_payment')).toEqual([expect.objectContaining({ label: 'paused', amount: 1250 })])

    // The same row again (a re-import, the nightly run): nothing new.
    const again = await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [row.id as string] })
    expect(again.hits).toBe(0)
    expect(await sweepCollectionPayments(sweepDeps())).toMatchObject({ hits: 0 })
    expect(hits()).toHaveLength(1)

    const view = await loadPossiblePayments(world.db.client, COMPANY_ID, caseId)
    expect(view).toEqual([
      expect.objectContaining({ transactionId: row.id, amount: 1250, date: '2026-10-05', reason: 'reference', pauseState: 'paused' }),
    ])
  })

  it('leaves an unrelated row, an outgoing row and a booked row alone', async () => {
    const unrelated = bankRow({ description: 'Ränta', amount: 3 })
    const outgoing = bankRow({ reference: '20261042', amount: -1250 })
    const booked = bankRow({ reference: '20261042', journal_entry_id: randomUUID() }, 'transactions')
    const summary = await sweepCollectionPayments(sweepDeps(), {
      companyId: COMPANY_ID,
      transactionIds: [unrelated.id, outgoing.id, booked.id] as string[],
    })
    expect(summary.hits).toBe(0)
    expect(caseRow()).toMatchObject({ paused_by_sweep: false })
    expect(hits()).toEqual([])
  })

  it("matches the customer's name only up to what is left to pay", async () => {
    const tooMuch = bankRow({ merchant_name: 'Kundbolaget Norr AB', amount: 5000 })
    expect((await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [tooMuch.id as string] })).hits).toBe(0)
    const partial = bankRow({ merchant_name: 'Kundbolaget Norr AB', amount: 500 })
    expect((await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [partial.id as string] })).hits).toBe(1)
    expect(hits()[0]).toMatchObject({ reason: 'name', amount: 500 })
  })

  it('skips a row the person already said is not a payment of the invoice at the handover', async () => {
    const row = bankRow({ reference: '20261042' })
    caseRow().bank_check = { ...(caseRow().bank_check as object), dismissed: [{ transaction_id: row.id, by: ADMIN_ID, at: new Date().toISOString() }] }
    expect((await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [row.id as string] })).hits).toBe(0)
  })

  it('finds every unexplained row in the nightly run', async () => {
    bankRow({ reference: '20261042', amount: 400 })
    bankRow({ date: '2026-07-01', reference: '20261042' }) // before the invoice date
    const summary = await sweepCollectionPayments(sweepDeps())
    expect(summary).toMatchObject({ cases: 1, hits: 1, paused: 1 })
  })
})

describe('when the provider cannot pause', () => {
  it('records a failed pause and tries again on a later sync run with the same key', async () => {
    const calls: string[] = []
    const failing: CollectionsAdapter = {
      ...world.adapter,
      async caseAction(ctx, input) {
        calls.push(input.idempotencyKey)
        throw retryableError()
      },
    }
    const row = bankRow({ reference: '20261042' })
    const summary = await sweepCollectionPayments(sweepDeps(failing), { companyId: COMPANY_ID, transactionIds: [row.id as string] })
    expect(summary).toMatchObject({ hits: 1, paused: 0, failed: 1 })
    expect(hits()[0]).toMatchObject({ pause_state: 'failed', pause_attempts: 1, pause_error: 'CONNECTOR_UNREACHABLE' })
    expect(caseRow().paused_by_sweep).toBe(false)
    expect(events('possible_payment')).toEqual([expect.objectContaining({ label: 'failed' })])

    // Too soon for a retry.
    expect((await sweepUpkeep(sweepDeps())).retried).toBe(0)
    hits()[0].updated_at = new Date(world.clock.now - SWEEP_PAUSE_RETRY_AFTER_MS - 1).toISOString()
    const upkeep = await sweepUpkeep(sweepDeps())
    expect(upkeep).toMatchObject({ retried: 1, paused: 1 })
    expect(hits()[0]).toMatchObject({ pause_state: 'paused', pause_attempts: 2, pause_error: null })
    expect(caseRow()).toMatchObject({ stage: 'paused', paused_by_sweep: true })
    expect(calls).toEqual([`${caseId}:sweep:${row.id}`])
    expect(events('possible_payment').map((e) => e.label)).toEqual(['failed', 'paused'])
  })

  it('pauses later when a step that offered no pause moves on', async () => {
    caseRow().actions = ['withdraw']
    const row = bankRow({ reference: '20261042' })
    const summary = await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [row.id as string] })
    expect(summary).toMatchObject({ hits: 1, notPaused: 1 })
    expect(hits()[0]).toMatchObject({ pause_state: 'unavailable' })

    hits()[0].updated_at = new Date(world.clock.now - SWEEP_PAUSE_RETRY_AFTER_MS - 1).toISOString()
    expect((await sweepUpkeep(sweepDeps())).retried).toBe(0)
    caseRow().actions = ['pause', 'withdraw']
    expect(await sweepUpkeep(sweepDeps())).toMatchObject({ retried: 1, paused: 1 })
    expect(caseRow()).toMatchObject({ paused_by_sweep: true })
  })

  it('leaves a case the person paused as it is', async () => {
    const result = await pauseCaseAutomatically(sweepDeps(), { ...normalizeCaseRow(caseRow()), stage: 'paused' }, {
      idempotencyKey: 'k',
      reason: 'possible_payment',
    })
    expect(result.outcome).toBe('already_paused')
    expect(caseRow().paused_by_sweep).toBe(false)
  })
})

describe('answering a possible payment', () => {
  async function pausedOver() {
    const row = bankRow({ reference: '20261042' })
    await sweepCollectionPayments(sweepDeps(), { companyId: COMPANY_ID, transactionIds: [row.id as string] })
    return row
  }

  it('is answered when the bank row is booked', async () => {
    const row = await pausedOver()
    row.invoice_id = INVOICE_ID
    expect(await loadPossiblePayments(world.db.client, COMPANY_ID, caseId)).toEqual([])
    expect((await sweepUpkeep(sweepDeps())).resolved).toBe(1)
    expect(hits()[0]).toMatchObject({ status: 'booked' })
    // The case stays paused until a person resumes it.
    expect(caseRow().paused_by_sweep).toBe(true)
  })

  it('is answered when the person says it pays something else, once', async () => {
    await pausedOver()
    const hitId = hits()[0]!.id as string
    expect(await dismissPossiblePayment(world.db.client, { companyId: COMPANY_ID, invoiceId: randomUUID(), hitId, userId: ADMIN_ID })).toEqual({
      ok: false,
      code: 'COLLECTION_POSSIBLE_PAYMENT_NOT_FOUND',
    })
    expect(await dismissPossiblePayment(world.db.client, { companyId: COMPANY_ID, invoiceId: INVOICE_ID, hitId, userId: ADMIN_ID })).toEqual({
      ok: true,
    })
    expect(hits()[0]).toMatchObject({ status: 'dismissed', resolved_by: ADMIN_ID })
    expect(events('possible_payment').map((e) => e.label)).toEqual(['paused', 'dismissed'])
    expect(await dismissPossiblePayment(world.db.client, { companyId: COMPANY_ID, invoiceId: INVOICE_ID, hitId, userId: ADMIN_ID })).toEqual({
      ok: false,
      code: 'COLLECTION_POSSIBLE_PAYMENT_NOT_ACTIONABLE',
    })
  })

  it("ends the automatic pause when a person resumes the case", async () => {
    await pausedOver()
    expect(caseRow().actions).toContain('resume')
    const resumed = await runCaseAction(world.deps(), { invoiceId: INVOICE_ID, action: 'resume' })
    expect(resumed.ok).toBe(true)
    expect(caseRow()).toMatchObject({ paused_by_sweep: false, pause_reason: null })
  })

  it('closes the open hits of a case the provider closed', async () => {
    await pausedOver()
    caseRow().is_open = false
    expect((await sweepUpkeep(sweepDeps())).resolved).toBe(1)
    expect(hits()[0]).toMatchObject({ status: 'closed' })
  })
})
