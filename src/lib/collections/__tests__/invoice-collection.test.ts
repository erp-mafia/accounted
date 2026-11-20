import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionsAdapter } from '../port'
import { loadInvoiceCase, loadInvoiceReadiness } from '../invoice-collection'
import { openCollectionCase } from '../open-case'
import { createCaseWorld, INVOICE_ID, MINUTE, OPENED_AT, refusedError } from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

vi.mock('../case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('./case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

beforeEach(() => vi.clearAllMocks())

function forward(overrides: Record<string, unknown>) {
  return {
    id: `fwd-${Math.random().toString(16).slice(2)}`,
    company_id: COMPANY_ID,
    kind: 'payment',
    invoice_payment_id: 'pay-1',
    credit_invoice_id: null,
    amount: 500,
    payment_date: '2026-10-06',
    status: 'pending',
    attempts: 0,
    next_attempt_at: null,
    forwarded_at: null,
    reverted_at: null,
    created_at: new Date(OPENED_AT).toISOString(),
    ...overrides,
  }
}

describe('loadInvoiceCase', () => {
  it('answers null for an invoice never handed over', async () => {
    const world = await createCaseWorld()
    expect(await loadInvoiceCase({ db: world.db.client, adapterFor: () => world.adapter, now: world.now }, COMPANY_ID, INVOICE_ID, { refresh: true })).toBeNull()
  })

  it('re-reads an open case from the provider at most once a minute', async () => {
    const world = await createCaseWorld()
    await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
    let reads = 0
    const counting: CollectionsAdapter = {
      ...world.adapter,
      async getCase(ctx, ref) {
        reads++
        return world.fake.getCase(ctx, ref)
      },
    }
    const deps = { db: world.db.client, adapterFor: () => counting, now: world.now }
    world.db.rows('collection_cases')[0].last_synced_at = new Date(OPENED_AT).toISOString()

    world.clock.now = OPENED_AT + 30_000
    expect((await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: true }))?.stage).toBe('registered')
    expect(reads).toBe(0)

    world.clock.now = OPENED_AT + 2 * MINUTE
    const view = await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: true })
    expect(reads).toBe(1)
    expect(view).toMatchObject({ stage: 'reminder', isOpen: true, submissionStatus: 'registered' })
    expect(view?.events.length).toBeGreaterThan(0)
    expect(view).not.toHaveProperty('provider_case_ref')
  })

  it('re-reads the case at once when a payment reached the provider after the stored snapshot', async () => {
    const world = await createCaseWorld()
    await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
    let reads = 0
    const counting: CollectionsAdapter = {
      ...world.adapter,
      async getCase(ctx, ref) {
        reads++
        return world.fake.getCase(ctx, ref)
      },
    }
    const deps = { db: world.db.client, adapterFor: () => counting, now: world.now }
    const caseRow = world.db.rows('collection_cases')[0]
    caseRow.last_synced_at = new Date(OPENED_AT).toISOString()
    world.db.seed('collection_payment_forwards', [
      forward({ case_id: caseRow.id, status: 'forwarded', forwarded_at: new Date(OPENED_AT + 10_000).toISOString() }),
    ])

    // Within the throttle, but the snapshot predates the report: read again.
    world.clock.now = OPENED_AT + 30_000
    const view = await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: true })
    expect(reads).toBe(1)
    expect(view?.forwardsInFlight).toBe(false)

    // The new snapshot covers the report: the throttle stands again.
    world.clock.now = OPENED_AT + 40_000
    await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: true })
    expect(reads).toBe(1)
  })

  it('tells the page a payment report is still on its way, but not one waiting for a retry', async () => {
    const world = await createCaseWorld()
    await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
    const deps = { db: world.db.client, adapterFor: () => world.adapter, now: world.now }
    const caseRow = world.db.rows('collection_cases')[0]
    world.db.seed('collection_payment_forwards', [forward({ case_id: caseRow.id, status: 'pending' })])
    expect((await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: false }))?.forwardsInFlight).toBe(true)

    world.db.rows('collection_payment_forwards')[0].next_attempt_at = new Date(OPENED_AT + 5 * MINUTE).toISOString()
    expect((await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: false }))?.forwardsInFlight).toBe(false)
  })

  it('shows each letter and decision once however often the case is read', async () => {
    const world = await createCaseWorld()
    await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
    const deps = { db: world.db.client, adapterFor: () => world.adapter, now: world.now }
    let view = null
    for (const minutes of [2, 4, 7, 9]) {
      world.clock.now = OPENED_AT + minutes * MINUTE
      view = await loadInvoiceCase(deps, COMPANY_ID, INVOICE_ID, { refresh: true })
    }
    const labels = view!.events.map((e) => e.label)
    expect(labels).toEqual([...new Set(labels)])
    expect(view!.events.filter((e) => e.kind === 'letter')).toHaveLength(1)
  })

  it('keeps a refused handover on the card with its error, and offers no actions on it', async () => {
    const world = await createCaseWorld()
    world.openFailures.push(refusedError())
    await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
    const view = await loadInvoiceCase({ db: world.db.client, adapterFor: () => world.adapter, now: world.now }, COMPANY_ID, INVOICE_ID, { refresh: true })
    expect(view).toMatchObject({ submissionStatus: 'failed', isOpen: false, syncError: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID', actions: [] })
  })
})

describe('loadInvoiceReadiness', () => {
  it('answers null without a live connection', async () => {
    const world = await createCaseWorld()
    world.db.tables.set('collection_connections', [])
    expect(await loadInvoiceReadiness({ db: world.db.client, now: world.now, userId: ADMIN_ID }, COMPANY_ID, INVOICE_ID)).toBeNull()
  })

  it('names what a consumer lacks without blocking on the personnummer', async () => {
    const world = await createCaseWorld({ customer: { customer_type: 'individual', org_number: null, personal_number: null, address_line1: null } })
    const readiness = await loadInvoiceReadiness({ db: world.db.client, now: world.now, userId: ADMIN_ID }, COMPANY_ID, INVOICE_ID)
    expect(readiness).toMatchObject({
      eligible: false,
      customer: { kind: 'private', identity: 'missing', missingAddress: ['address_line1'] },
      hints: ['debtor_missing_personal_number'],
      blocks: [{ code: 'debtor_missing_address' }],
      startSteps: ['reminder', 'collection'],
      defaultStartStep: 'reminder',
    })
  })
})
