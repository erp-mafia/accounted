import { gatherDailyBatch, stageDailyBatch } from '../autopilot'
import { COLLECTIONS_BATCH_TYPE } from '../batch'
import { loadOpenCaseForInvoice, type CollectionCaseRow } from '../case'
import { loadLiveConnection, type CollectionConnectionRow } from '../connection'
import { refreshCase } from '../invoice-collection'
import { openCollectionCase } from '../open-case'
import { CONNECTION_ID, createCaseWorld, ENV_ON, INVOICE_ID, MINUTE, OPENED_AT, type CaseWorld } from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

/**
 * A case world (case-fixtures.ts) whose connection runs the daily batch:
 * ladder 'staged', 10 days after due, chosen by ADMIN_ID; OWNER_ID owns the
 * company. Shared by the autopilot and batch-commit tests. Tests that use it
 * mock ../case-document as case-actions.test.ts does.
 */

export const LADDER_ENV = { ...ENV_ON, ladderEnabled: true }
export const OWNER_ID = '88888888-8888-4888-8888-888888888888'

/** A case world whose connection runs the ladder ('staged', 10 days), with the person who chose it as owner. */
export async function ladderWorld(options: Parameters<typeof createCaseWorld>[0] = {}): Promise<CaseWorld> {
  const world = await createCaseWorld(options)
  const connection = world.db.rows('collection_connections').find((r) => r.id === CONNECTION_ID)!
  Object.assign(connection, {
    ladder_mode: 'staged',
    ladder_days_after_due: 10,
    ladder_enabled_by: ADMIN_ID,
    ladder_enabled_at: '2026-10-01T08:00:00Z',
    default_start_step: 'reminder',
    minimum_amount: 100,
    reminder_fee_terms_since: '2026-01-01',
  })
  world.db.seed('company_members', [
    { company_id: COMPANY_ID, user_id: ADMIN_ID, role: 'admin' },
    { company_id: COMPANY_ID, user_id: OWNER_ID, role: 'owner' },
  ])
  return world
}

export async function connectionOf(world: CaseWorld): Promise<CollectionConnectionRow> {
  const connection = await loadLiveConnection(world.db.client, COMPANY_ID)
  if (!connection) throw new Error('expected a connection')
  return connection
}

export async function gather(world: CaseWorld) {
  return gatherDailyBatch(world.db.client, { companyId: COMPANY_ID, connection: await connectionOf(world), features: null, now: world.now() })
}

export async function stage(world: CaseWorld) {
  return stageDailyBatch(world.db.client, { companyId: COMPANY_ID, connection: await connectionOf(world), features: null, now: world.now() })
}

export function batches(world: CaseWorld) {
  return world.db.rows('pending_operations').filter((r) => r.operation_type === COLLECTIONS_BATCH_TYPE)
}

/** A registered case on the invoice, walked forward `minutes` fake minutes on the fake provider. */
export async function caseAfter(world: CaseWorld, minutes: number): Promise<CollectionCaseRow> {
  const opened = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!opened.ok || opened.dryRun) throw new Error('expected a case')
  world.clock.now = OPENED_AT + minutes * MINUTE
  await refreshCase({ db: world.db.client, adapterFor: () => world.adapter, now: world.now }, opened.case)
  const row = await loadOpenCaseForInvoice(world.db.client, COMPANY_ID, INVOICE_ID)
  if (!row) throw new Error('expected an open case')
  return row
}

