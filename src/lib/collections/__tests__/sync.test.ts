import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionsChanges, CollectionsChangesRequest } from '@accounted/connect-contract'
import { eventBus } from '@/lib/events'
import { openCollectionCase } from '../open-case'
import { applyCaseSnapshot, loadCaseById } from '../case'
import { changeFeedStart, nightlyDue, runCollectionsSync, SETTLEMENT_SYNC_RESERVE_MS, submissionRetryDelayMs } from '../sync'
import type { CollectionsAdapter } from '../port'
import { CONNECTION_ID, createCaseWorld, ENV_OFF, INVOICE_ID, MINUTE, OPENED_AT, retryableError, type CaseWorld } from './case-fixtures'
import { COMPANY_ID } from './memory-supabase'

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

function feed(pages: CollectionsChanges[]) {
  const requests: CollectionsChangesRequest[] = []
  const adapter = {
    route: 'connect',
    async changes(input: CollectionsChangesRequest) {
      requests.push(input)
      return pages.shift() ?? { changes: [], next: null }
    },
  } as unknown as CollectionsAdapter
  return { adapter, requests }
}

async function handedOver(world: CaseWorld) {
  const outcome = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!outcome.ok || outcome.dryRun) throw new Error('expected a case')
  return outcome.case
}

describe('changeFeedStart', () => {
  it('re-reads 200 positions back, never below zero, from the start without a cursor', () => {
    expect(changeFeedStart(null)).toBeNull()
    expect(changeFeedStart('nonsense')).toBeNull()
    expect(changeFeedStart('150')).toBe('0')
    expect(changeFeedStart('1000')).toBe('800')
    expect(changeFeedStart('90071992547409930')).toBe('90071992547409730')
  })
})

describe('submissionRetryDelayMs', () => {
  it('doubles from two minutes up to six hours', () => {
    expect(submissionRetryDelayMs(1)).toBe(2 * MINUTE)
    expect(submissionRetryDelayMs(2)).toBe(4 * MINUTE)
    expect(submissionRetryDelayMs(4)).toBe(16 * MINUTE)
    expect(submissionRetryDelayMs(40)).toBe(6 * 60 * MINUTE)
  })
})

describe('runCollectionsSync: cases', () => {
  it('reads the cases the change feed names, with an overlap, stores the cursor and the stage', async () => {
    const world = await createCaseWorld()
    const opened = await handedOver(world)
    world.db.rows('collection_sync_state')[0].cursor = '1000'
    world.clock.now = OPENED_AT + 2 * MINUTE
    const { adapter: feedAdapter, requests } = feed([
      { changes: [{ seq: '1001', companyRef: COMPANY_ID, kind: 'case', ref: opened.id, changedAt: world.now().toISOString() }], next: '1001' },
      { changes: [{ seq: '1002', companyRef: COMPANY_ID, kind: 'settlement', ref: 'payout-1', changedAt: world.now().toISOString() }], next: null },
    ])
    // Read only through the feed: the safety net would also pick a case never synced.
    world.db.rows('collection_cases')[0].last_synced_at = world.now().toISOString()
    world.db.rows('collection_connections')[0].route = 'connect'

    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter })
    expect(requests[0]).toEqual({ after: '800', limit: 500 })
    expect(requests[1]).toEqual({ after: '1001', limit: 500 })
    expect(summary.cases).toMatchObject({ changes: 2, refreshed: 1, failed: 0 })
    expect(world.db.rows('collection_sync_state')[0]).toMatchObject({ cursor: '1002', last_error: null })
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ stage: 'reminder', sync_error: null })
    // The provider's letter carries the move; no second row of our own.
    const transitions = world.db.rows('collection_case_events').filter((e) => e.stage_to !== null)
    expect(transitions).toMatchObject([{ kind: 'letter', stage_from: 'registered', stage_to: 'reminder' }])
  })

  it('never acts on a change that names another company', async () => {
    const world = await createCaseWorld()
    const opened = await handedOver(world)
    world.db.rows('collection_cases')[0].last_synced_at = new Date(OPENED_AT + 10 * MINUTE).toISOString()
    world.db.rows('collection_connections')[0].route = 'connect'
    world.clock.now = OPENED_AT + 2 * MINUTE
    // Not the nightly run (which re-reads every open case on its own).
    world.db.rows('collection_sync_state')[0].last_daily_at = world.now().toISOString()
    const { adapter: feedAdapter, requests } = feed([
      { changes: [{ seq: '7', companyRef: 'someone-else', kind: 'case', ref: opened.id, changedAt: world.now().toISOString() }], next: null },
    ])
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter })
    expect(requests).toHaveLength(1)
    expect(summary.cases.refreshed).toBe(0)
    expect(world.db.rows('collection_cases')[0].stage).toBe('registered')
  })

  it('never calls the feed while no company has a connection through Connect (a dark installation)', async () => {
    const world = await createCaseWorld()
    await handedOver(world)
    world.db.rows('collection_cases')[0].last_synced_at = new Date(OPENED_AT + 10 * MINUTE).toISOString()
    world.clock.now = OPENED_AT + 2 * MINUTE
    const { adapter: feedAdapter, requests } = feed([{ changes: [], next: null }])
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter })
    expect(requests).toHaveLength(0)
    expect(summary.cases).toMatchObject({ changes: 0, failed: 0 })
  })

  it('records the provider timeline once however often the case is re-read', async () => {
    const world = await createCaseWorld()
    const opened = await handedOver(world)
    world.clock.now = OPENED_AT + 3 * MINUTE
    const snapshot = await world.fake.getCase({ companyId: COMPANY_ID, connectionHandle: null }, { caseRef: opened.provider_case_ref! })
    const row = (await loadCaseById(world.db.client, COMPANY_ID, opened.id))!
    await applyCaseSnapshot(world.db.client, row, snapshot, { now: world.now() })
    const again = (await loadCaseById(world.db.client, COMPANY_ID, opened.id))!
    await applyCaseSnapshot(world.db.client, again, snapshot, { now: world.now() })
    const providerEvents = world.db.rows('collection_case_events').filter((e) => e.provider_event_ref !== null)
    expect(providerEvents.length).toBe(snapshot.events.length)
    expect(new Set(providerEvents.map((e) => e.provider_event_ref)).size).toBe(snapshot.events.length)
    // Each letter once: the provider's row carries the stage move, no row of our own repeats it.
    expect(world.db.rows('collection_case_events').filter((e) => e.provider_event_ref === null)).toHaveLength(0)
    expect(world.db.rows('collection_case_events').filter((e) => e.stage_to === 'reminder')).toHaveLength(1)
  })

  it('writes a stage row of its own only when the provider reports no event for the move', async () => {
    const world = await createCaseWorld()
    const opened = await handedOver(world)
    world.clock.now = OPENED_AT + 3 * MINUTE
    const snapshot = await world.fake.getCase({ companyId: COMPANY_ID, connectionHandle: null }, { caseRef: opened.provider_case_ref! })
    const row = (await loadCaseById(world.db.client, COMPANY_ID, opened.id))!
    await applyCaseSnapshot(world.db.client, row, { ...snapshot, events: [] }, { now: world.now() })
    expect(world.db.rows('collection_case_events')).toMatchObject([
      { kind: 'stage', provider_event_ref: null, stage_from: 'registered', stage_to: 'reminder' },
    ])
  })

  it('retries a timed-out handover with backoff and completes it with the same key', async () => {
    const world = await createCaseWorld()
    world.openFailures.push(retryableError())
    const opened = await handedOver(world)
    expect(opened.submission_status).toBe('submitted')
    const run = () => runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter: null })

    // Not yet rested. (updated_at is the memory client's wall time: pin it to the fake clock.)
    world.db.rows('collection_cases')[0].updated_at = new Date(OPENED_AT).toISOString()
    world.clock.now = OPENED_AT + MINUTE
    expect((await run()).cases.retried).toBe(0)

    world.openFailures.push(retryableError())
    world.clock.now = OPENED_AT + 3 * MINUTE
    expect((await run()).cases).toMatchObject({ retried: 1, registered: 0 })
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ submission_status: 'submitted', submission_attempts: 2 })

    // Second attempt rests four minutes.
    world.db.rows('collection_cases')[0].updated_at = new Date(OPENED_AT + 3 * MINUTE).toISOString()
    world.clock.now = OPENED_AT + 6 * MINUTE
    expect((await run()).cases.retried).toBe(0)
    world.clock.now = OPENED_AT + 8 * MINUTE
    expect((await run()).cases).toMatchObject({ retried: 1, registered: 1 })
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ submission_status: 'registered', submission_request: null })
    expect(new Set(world.openRequests.map((r) => r.idempotencyKey))).toEqual(new Set([opened.id]))
  })

  it('starts no case work that could outlive the cron run', async () => {
    const world = await createCaseWorld()
    world.openFailures.push(retryableError())
    await handedOver(world)
    world.db.rows('collection_cases')[0].updated_at = new Date(OPENED_AT).toISOString()
    world.clock.now = OPENED_AT + 10 * MINUTE
    const summary = await runCollectionsSync({
      db: world.db.client,
      env: ENV_OFF,
      now: world.now,
      adapterFor: () => world.adapter,
      feedAdapter: null,
      budgetMs: 100_000,
    })
    expect(summary.cases).toMatchObject({ retried: 0, refreshed: 0 })
    expect(world.openRequests).toHaveLength(1)
  })

  it('releases a reservation that never reached the provider', async () => {
    const world = await createCaseWorld()
    world.db.seed('collection_cases', [
      {
        id: 'stale',
        company_id: COMPANY_ID,
        invoice_id: INVOICE_ID,
        connection_id: CONNECTION_ID,
        submission_status: 'preparing',
        is_open: true,
        updated_at: new Date(OPENED_AT - 20 * MINUTE).toISOString(),
      },
    ])
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter: null })
    expect(summary.cases.released).toBe(1)
    expect(world.db.rows('collection_cases')).toEqual([])
  })

  it('re-reads sandbox cases on the fake provider every few minutes, without a feed', async () => {
    const world = await createCaseWorld()
    await handedOver(world)
    world.clock.now = OPENED_AT + 6 * MINUTE
    world.db.rows('collection_cases')[0].last_synced_at = new Date(OPENED_AT).toISOString()
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter: null })
    expect(summary.cases.refreshed).toBe(1)
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ stage: 'awaiting_decision', decision_kind: 'approve_collection_notice' })
  })

  it('keeps the reserve for the settlement work: with only the reserve left, the cases wait and the payouts go on', async () => {
    const world = await createCaseWorld()
    await handedOver(world)
    world.clock.now = OPENED_AT + 6 * MINUTE
    world.db.rows('collection_cases')[0].last_synced_at = new Date(OPENED_AT).toISOString()
    world.db.seed('collection_settlements', [
      {
        id: 'stl-1',
        company_id: COMPANY_ID,
        connection_id: CONNECTION_ID,
        provider_settlement_ref: '7731',
        payment_date: '2026-10-01',
        amount: 100,
        currency: 'SEK',
        status: 'booked',
        journal_entry_id: 'je-d1',
        booked_at: world.now().toISOString(),
        provider_acknowledged_at: null,
        bank_reference: null,
      },
    ])
    // The fake provider never pays out; this one takes the booked mark.
    const adapter: CollectionsAdapter = { ...world.adapter, markSettlementBooked: vi.fn(async () => null) }
    const summary = await runCollectionsSync({
      db: world.db.client,
      env: ENV_OFF,
      now: world.now,
      adapterFor: () => adapter,
      feedAdapter: null,
      budgetMs: SETTLEMENT_SYNC_RESERVE_MS,
      clock: () => 0,
    })
    expect(summary.cases.refreshed).toBe(0)
    expect(summary.settlements).toMatchObject({ acknowledged: 1, deferred: 0 })
  })

  it('records a failed read on the case and keeps going', async () => {
    const world = await createCaseWorld()
    await handedOver(world)
    world.clock.now = OPENED_AT + 6 * MINUTE
    world.db.rows('collection_cases')[0].last_synced_at = null
    const broken: CollectionsAdapter = {
      ...world.adapter,
      async getCase() {
        throw retryableError()
      },
    }
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => broken, feedAdapter: null })
    expect(summary.cases.failed).toBe(1)
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ sync_error: 'CONNECTOR_UNREACHABLE', stage: 'registered', is_open: true })
  })
})

describe('nightlyDue', () => {
  it('runs on the first run of a night, at most once in 20 hours, and after 30 hours whatever the hour', () => {
    const night = new Date('2026-10-07T01:30:00Z') // 03:30 in Stockholm
    const day = new Date('2026-10-07T12:00:00Z')
    expect(nightlyDue(null, day)).toBe(true)
    expect(nightlyDue('2026-10-06T01:00:00Z', night)).toBe(true)
    expect(nightlyDue('2026-10-07T00:30:00Z', night)).toBe(false)
    expect(nightlyDue('2026-10-06T08:00:00Z', day)).toBe(false)
    expect(nightlyDue('2026-10-06T05:00:00Z', day)).toBe(true)
  })
})

describe('runCollectionsSync: the nightly sweep and reconcile', () => {
  it('pauses a case over an unbooked bank row, reconciles, and marks the night done', async () => {
    const world = await createCaseWorld()
    const opened = await handedOver(world)
    world.clock.now = OPENED_AT + 30 * MINUTE
    world.db.seed('open_bank_rows', [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        company_id: COMPANY_ID,
        date: '2026-10-05',
        amount: 1250,
        description: 'Inbetalning',
        reference: '20261042',
        is_ignored: false,
        invoice_id: null,
        supplier_invoice_id: null,
        journal_entry_id: null,
        is_business: null,
      },
    ])
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter: null })
    expect(summary.nightly?.sweep).toMatchObject({ cases: 1, hits: 1, paused: 1 })
    expect(summary.nightly?.reconcile).toMatchObject({ checked: 1, mismatched: 0, complete: true })
    expect(world.db.rows('collection_cases')[0]).toMatchObject({ id: opened.id, stage: 'paused', paused_by_sweep: true })
    expect(world.db.rows('collection_sync_state')[0]!.last_daily_at).toBe(world.now().toISOString())

    // The next run is not a nightly one: only flagged cases are compared again.
    world.clock.now += 10 * MINUTE
    const next = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter: null })
    expect(next.nightly).toBeNull()
    expect(next.reconcile.checked).toBe(0)
  })

  it('makes sure of the forward rows before the drain and keeps going when that fails', async () => {
    const world = await createCaseWorld()
    await handedOver(world)
    const order: string[] = []
    world.db.rpcs.set('reconcile_collection_forwards', () => {
      order.push('reconcile')
      throw new Error('boom')
    })
    world.db.rpcs.set('claim_collection_forwards', () => {
      order.push('claim')
      return []
    })
    const summary = await runCollectionsSync({ db: world.db.client, env: ENV_OFF, now: world.now, adapterFor: () => world.adapter, feedAdapter: null })
    expect(order.slice(0, 2)).toEqual(['reconcile', 'claim'])
    expect(summary.forwardRows).toEqual({ createdPayments: 0, createdCredits: 0, reverted: 0, skipped: 0 })
  })
})
