import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsCaseActionRequest } from '@accounted/connect-contract'
import { eventBus } from '@/lib/events'
import { batchApprovalRefusal, batchItemCaseId, commitCollectionsDailyBatch, uuidV5 } from '../batch-commit'
import { loadOpenCaseForInvoice } from '../case'
import { encodeFakeCaseRef } from '../adapters/fake'
import type { CollectionsAdapter } from '../port'
import { batches, caseAfter, LADDER_ENV, ladderWorld, stage } from './batch-fixtures'
import { ENV_ON, INVOICE_ID, OPENED_AT, refusedError, type CaseWorld } from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

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

const STAGED_FACTS = (world: CaseWorld) => world.facts({ connection: { ...world.facts().connection!, ladderMode: 'staged' } })

/** Stage today's batch and return its operation row. */
async function stagedBatch(world: CaseWorld) {
  const outcome = await stage(world)
  if (outcome.status !== 'staged') throw new Error(`expected a staged batch, got ${outcome.status}`)
  return batches(world).find((r) => r.id === outcome.operationId)!
}

async function commit(world: CaseWorld, op: Record<string, unknown>, adapter: CollectionsAdapter = world.adapter) {
  return commitCollectionsDailyBatch(
    {
      supabase: world.db.client as unknown as SupabaseClient,
      userId: ADMIN_ID,
      userLabel: 'ada@test.se',
      companyId: COMPANY_ID,
      operation: { id: op.id as string, params: op.params as Record<string, unknown> },
    },
    { db: world.db.client as unknown as SupabaseClient, env: LADDER_ENV, facts: STAGED_FACTS(world), now: world.now, adapterFor: () => adapter },
  )
}

const BANK_ROW = {
  id: 'tx-late',
  company_id: COMPANY_ID,
  date: '2026-10-05',
  amount: 1250,
  description: 'Betalning 20261042',
  original_description: null,
  merchant_name: null,
  reference: null,
  potential_invoice_id: null,
  is_ignored: false,
  invoice_id: null,
  supplier_invoice_id: null,
  journal_entry_id: null,
  is_business: true,
}

describe('uuid v5 case ids', () => {
  it('follows RFC 4122 (the DNS namespace example)', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('derives one stable id per operation, invoice and kind', () => {
    const a = batchItemCaseId('op-1', INVOICE_ID, 'open')
    expect(batchItemCaseId('op-1', INVOICE_ID, 'open')).toBe(a)
    expect(batchItemCaseId('op-2', INVOICE_ID, 'open')).not.toBe(a)
    expect(batchItemCaseId('op-1', INVOICE_ID, 'start')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('commitCollectionsDailyBatch', () => {
  it('hands an approved invoice over as a batch case under the derived id', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    const outcome = await commit(world, op)
    const caseId = batchItemCaseId(op.id as string, INVOICE_ID, 'open')
    expect(outcome).toEqual({
      ok: true,
      data: { batch_date: '2026-10-06', done: [{ invoice_id: INVOICE_ID, kind: 'open', case_id: caseId }], skipped: [], done_count: 1, skipped_count: 0 },
    })
    expect(world.openRequests).toHaveLength(1)
    expect(world.db.rows('collection_cases')[0]).toMatchObject({
      id: caseId,
      origin: 'batch',
      pending_operation_id: op.id,
      opened_by: ADMIN_ID,
      submission_status: 'registered',
    })
  })

  it('runs again without a second handover (the case id is the key)', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    await commit(world, op)
    const again = await commit(world, op)
    expect(again).toMatchObject({ ok: true, data: { done_count: 1, skipped_count: 0 } })
    expect(world.openRequests).toHaveLength(1)
    expect(world.db.rows('collection_cases')).toHaveLength(1)
  })

  it('skips an invoice whose remaining amount changed since the morning', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    Object.assign(world.db.rows('invoices')[0]!, { status: 'partially_paid', paid_amount: 250, remaining_amount: 1000 })
    expect(await commit(world, op)).toMatchObject({
      ok: true,
      data: { done_count: 0, skipped: [{ invoice_id: INVOICE_ID, kind: 'open', reason: 'changed', code: 'COLLECTION_REMAINING_CHANGED' }] },
    })
    expect(world.openRequests).toEqual([])
  })

  it('skips an invoice a new bank row may have paid', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    world.db.seed('transactions', [BANK_ROW])
    expect(await commit(world, op)).toMatchObject({
      ok: true,
      data: { done_count: 0, skipped: [{ reason: 'bank', code: 'COLLECTION_BANK_CANDIDATES' }] },
    })
  })

  it('skips an invoice whose bank went stale since the morning: no attestation is given here', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    world.clock.now = OPENED_AT + 26 * 3_600_000
    expect(await commit(world, op)).toMatchObject({ ok: true, data: { skipped: [{ reason: 'bank', code: 'COLLECTION_ATTESTATION_REQUIRED' }] } })
    expect(world.openRequests).toEqual([])
  })

  it('skips a customer marked "Skicka aldrig till inkasso" since the batch was staged', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    const invoice = world.db.rows('invoices')[0]!
    invoice.customer = { ...(invoice.customer as Record<string, unknown>), collections_excluded: true }
    expect(await commit(world, op)).toMatchObject({
      ok: true,
      data: { skipped: [{ reason: 'ineligible', code: 'COLLECTION_CUSTOMER_EXCLUDED' }] },
    })
  })

  it('sends nothing for an item an administrator took out', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    world.db.seed('collection_batch_removals', [
      { company_id: COMPANY_ID, pending_operation_id: op.id, invoice_id: INVOICE_ID, kind: 'open', removed_by: ADMIN_ID, removed_at: '2026-10-06T07:00:00Z' },
    ])
    expect(await commit(world, op)).toMatchObject({ ok: true, data: { done: [], skipped: [], done_count: 0 } })
    expect(world.openRequests).toEqual([])
  })

  it('reports the provider refusing a handover as the provider not answering', async () => {
    const world = await ladderWorld()
    const op = await stagedBatch(world)
    world.openFailures.push(refusedError())
    expect(await commit(world, op)).toMatchObject({ ok: true, data: { skipped: [{ reason: 'connector', code: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID' }] } })
  })

  it('approves the next step a case waits for, after the bank check', async () => {
    const world = await ladderWorld()
    const row = await caseAfter(world, 6)
    world.db.rows('bank_connections')[0]!.last_synced_at = new Date(world.clock.now - 60_000).toISOString()
    const op = await stagedBatch(world)
    expect((op.params as { items: Array<{ kind: string }> }).items).toEqual([expect.objectContaining({ kind: 'approve_step', case_id: row.id })])
    const sent: CollectionsCaseActionRequest[] = []
    const adapter: CollectionsAdapter = {
      ...world.adapter,
      async caseAction(ctx, input) {
        sent.push(input)
        return world.fake.caseAction(ctx, input)
      },
    }
    expect(await commit(world, op, adapter)).toMatchObject({ ok: true, data: { done: [{ kind: 'approve_step', case_id: row.id }], skipped_count: 0 } })
    expect(sent).toEqual([expect.objectContaining({ action: 'approve_step' })])
  })

  it('starts reminders on an invoice the provider only delivered, on that same case, and not once a bank row may be the payment', async () => {
    const world = await ladderWorld()
    const row = await caseAfter(world, 0)
    // The provider only delivered the invoice: its claim waits for an explicit start.
    const caseRef = encodeFakeCaseRef({ step: 'invoice', openedAt: OPENED_AT, claimAmount: 1250, claimRemaining: 1250, invoiceRef: INVOICE_ID })
    Object.assign(world.db.rows('collection_cases').find((r) => r.id === row.id)!, {
      stage: 'invoice_sent',
      start_step: 'invoice',
      actions: ['start', 'withdraw'],
      provider_case_ref: caseRef,
    })
    const op = await stagedBatch(world)
    expect((op.params as { items: Array<{ kind: string }> }).items).toEqual([expect.objectContaining({ kind: 'start', case_id: row.id })])
    const sent: CollectionsCaseActionRequest[] = []
    const adapter: CollectionsAdapter = {
      ...world.adapter,
      async caseAction(ctx, input) {
        sent.push(input)
        return world.fake.caseAction(ctx, input)
      },
    }
    const openCase = vi.spyOn(adapter, 'openCase')

    // A payment that may be this invoice's arrived after the batch was staged.
    world.db.seed('transactions', [BANK_ROW])
    expect(await commit(world, op, adapter)).toMatchObject({ ok: true, data: { done: [], skipped: [{ reason: 'bank' }] } })
    expect(sent).toEqual([])

    world.db.rows('transactions').splice(0)
    expect(await commit(world, op, adapter)).toMatchObject({ ok: true, data: { done: [{ kind: 'start', case_id: row.id }], skipped_count: 0 } })
    expect(sent).toEqual([expect.objectContaining({ action: 'start', step: 'reminder' })])
    expect(openCase).not.toHaveBeenCalled()
  })

  it('skips an approval whose case moved on, and one whose amount changed', async () => {
    const world = await ladderWorld()
    const row = await caseAfter(world, 6)
    world.db.rows('bank_connections')[0]!.last_synced_at = new Date(world.clock.now - 60_000).toISOString()
    const op = await stagedBatch(world)

    Object.assign(world.db.rows('collection_cases').find((r) => r.id === row.id)!, { stage: 'collection', decision_kind: null })
    expect(await commit(world, op)).toMatchObject({ ok: true, data: { skipped: [{ reason: 'ineligible', code: 'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE' }] } })

    Object.assign(world.db.rows('collection_cases').find((r) => r.id === row.id)!, { stage: 'awaiting_decision', decision_kind: 'approve_collection_notice' })
    Object.assign(world.db.rows('invoices')[0]!, { status: 'partially_paid', paid_amount: 250, remaining_amount: 1000 })
    expect(await commit(world, op)).toMatchObject({ ok: true, data: { skipped: [{ reason: 'changed', code: 'COLLECTION_REMAINING_CHANGED' }] } })
    expect((await loadOpenCaseForInvoice(world.db.client, COMPANY_ID, INVOICE_ID))?.stage).toBe('awaiting_decision')
  })

  it('refuses params it cannot read', async () => {
    const world = await ladderWorld()
    expect(await commit(world, { id: 'op-x', params: { items: 'nope' } })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', status: 400 })
  })
})

describe('batchApprovalRefusal', () => {
  const supabase = {} as SupabaseClient

  it('wants an owner or administrator', async () => {
    const world = await ladderWorld()
    expect(
      await batchApprovalRefusal(supabase, COMPANY_ID, { env: LADDER_ENV, isAdmin: async () => false, loadFacts: async () => STAGED_FACTS(world) }),
    ).toMatchObject({ code: 'COLLECTION_BATCH_ADMIN_ONLY', status: 403 })
  })

  it('wants the daily batch start gates to still say yes', async () => {
    const world = await ladderWorld()
    const admin = async () => true
    expect(await batchApprovalRefusal(supabase, COMPANY_ID, { env: LADDER_ENV, isAdmin: admin, loadFacts: async () => STAGED_FACTS(world) })).toBeNull()
    expect(await batchApprovalRefusal(supabase, COMPANY_ID, { env: ENV_ON, isAdmin: admin, loadFacts: async () => STAGED_FACTS(world) })).toMatchObject({
      code: 'COLLECTIONS_DISABLED',
      status: 503,
    })
    expect(await batchApprovalRefusal(supabase, COMPANY_ID, { env: LADDER_ENV, isAdmin: admin, loadFacts: async () => world.facts() })).toMatchObject({
      code: 'COLLECTIONS_NOT_ACTIVE',
      status: 409,
    })
    expect(
      await batchApprovalRefusal(supabase, COMPANY_ID, {
        env: LADDER_ENV,
        isAdmin: admin,
        loadFacts: async () => ({ ...STAGED_FACTS(world), capability: false }),
      }),
    ).toMatchObject({ code: 'capability_blocked', status: 403 })
  })
})
