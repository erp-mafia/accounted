/**
 * Customer merge service (crm#1398, crm#1299): the rules the RPC cannot
 * apply (a personnummer is encrypted with the application's key), which
 * function a dry run calls, and how the RPC's answers reach the doors. The
 * moves themselves are pinned against Postgres in
 * tests/pg/customer-merge.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { encryptCustomerPersonalNumber } from '../protect-personal-number'
import { mergeCustomers, undoCustomerMerge } from '../merge-customers'

const SURVIVOR = '11111111-1111-4111-8111-111111111111'
const DUPLICATE = '22222222-2222-4222-8222-222222222222'
const MERGE_ID = '33333333-3333-4333-8333-333333333333'
// Skatteverket's published test personnummer, never invented ones.
const PERSON = '195001182046'
const OTHER_PERSON = '201212121212'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

const ANSWER = {
  ok: true,
  dry_run: false,
  survivor: { customer_id: SURVIVOR, name: 'Kunden AB', customer_number: '120' },
  merged: [{
    customer_id: DUPLICATE, name: 'Kunden AB', customer_number: '120', merge_id: MERGE_ID, was_archived: false,
    invoices: 71, sales_orders: 0, recurring_invoice_schedules: 1, deadlines: 0, source_records: 1,
  }],
  totals: { invoices: 71, sales_orders: 0, recurring_invoice_schedules: 1, deadlines: 0 },
}

function setup(personalNumbers: Record<string, string | null> = {}) {
  const mock = createTableMockSupabase()
  mock.setTable('customers', {
    data: [SURVIVOR, DUPLICATE].map((id) => ({ id, personal_number: personalNumbers[id] ?? null })),
  })
  const ctx = { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log }
  return { mock, ctx }
}

beforeEach(() => {
  vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'merge-customers-unit-test-only')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('mergeCustomers', () => {
  it('previews with the read-only customer_merge_preview and writes nothing', async () => {
    const { mock, ctx } = setup()
    mock.setTable('rpc:customer_merge_preview', { data: { ...ANSWER, dry_run: true, merged: [{ ...ANSWER.merged[0], merge_id: null }] } })

    const outcome = await mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE, DUPLICATE] }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { totals: { invoices: 71 }, merged: [{ merge_id: null }] } })
    expect(mock.findCall('rpc:customer_merge_preview', 'rpc')?.[0]).toEqual({
      p_company_id: 'company-1', p_survivor_id: SURVIVOR, p_merged_ids: [DUPLICATE], p_user_id: 'user-1',
    })
    expect(mock.findCall('rpc:merge_customers', 'rpc')).toBeUndefined()
  })

  it('merges with merge_customers and answers what moved', async () => {
    const { mock, ctx } = setup()
    mock.setTable('rpc:merge_customers', { data: ANSWER })

    const outcome = await mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }, { dryRun: false })

    expect(outcome).toEqual({ ok: true, data: { survivor: ANSWER.survivor, merged: ANSWER.merged, totals: ANSWER.totals } })
    expect(mock.findCall('rpc:merge_customers', 'rpc')?.[0]).toMatchObject({ p_survivor_id: SURVIVOR, p_merged_ids: [DUPLICATE] })
  })

  it('refuses the survivor among the merged before asking the database', async () => {
    const { mock, ctx } = setup()

    const outcome = await mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [SURVIVOR] }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'survivor_in_merged' } })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses two cards with different personnummer: two people', async () => {
    const { mock, ctx } = setup({
      [SURVIVOR]: encryptCustomerPersonalNumber(PERSON),
      [DUPLICATE]: encryptCustomerPersonalNumber(OTHER_PERSON),
    })

    const outcome = await mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { customer_id: DUPLICATE, field: 'personal_number' } })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('merges two cards with the same personnummer in different written forms, and one without', async () => {
    const { mock, ctx } = setup({
      [SURVIVOR]: encryptCustomerPersonalNumber('19500118-2046'),
      [DUPLICATE]: encryptCustomerPersonalNumber('500118-2046'),
    })
    mock.setTable('rpc:merge_customers', { data: ANSWER })

    expect(await mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }, { dryRun: false }))
      .toMatchObject({ ok: true })
  })

  it('passes the database refusal on with its code and details', async () => {
    const { mock, ctx } = setup()
    mock.setTable('rpc:merge_customers', {
      data: { ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { customer_id: DUPLICATE, field: 'org_number' } },
    })

    expect(await mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }, { dryRun: false }))
      .toEqual({ ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { customer_id: DUPLICATE, field: 'org_number' } })
  })

  it('throws on a database error instead of reporting a merge', async () => {
    const { mock, ctx } = setup()
    mock.setTable('rpc:merge_customers', { error: { message: 'deadlock detected' } })

    await expect(mergeCustomers(ctx, { survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }, { dryRun: false }))
      .rejects.toThrow(/merge_customers failed/)
  })
})

describe('undoCustomerMerge', () => {
  it('undoes with undo_customer_merge', async () => {
    const { mock, ctx } = setup()
    const restored = { invoices: 71, sales_orders: 0, recurring_invoice_schedules: 1, deadlines: 0, source_records: 1 }
    mock.setTable('rpc:undo_customer_merge', {
      data: { ok: true, merge_id: MERGE_ID, survivor_customer_id: SURVIVOR, restored_customer_id: DUPLICATE, restored },
    })

    expect(await undoCustomerMerge(ctx, MERGE_ID)).toEqual({
      ok: true, data: { merge_id: MERGE_ID, survivor_customer_id: SURVIVOR, restored_customer_id: DUPLICATE, restored },
    })
    expect(mock.findCall('rpc:undo_customer_merge', 'rpc')?.[0]).toEqual({ p_company_id: 'company-1', p_merge_id: MERGE_ID, p_user_id: 'user-1' })
  })

  it('dry-runs on the merge row alone: refuses one already undone, calls no write', async () => {
    const { mock, ctx } = setup()
    mock.setTable('customer_merges', {
      data: { id: MERGE_ID, survivor_id: SURVIVOR, merged_id: DUPLICATE, undone_at: '2026-10-22T10:00:00Z', created_at: new Date().toISOString() },
    })

    expect(await undoCustomerMerge(ctx, MERGE_ID, { dryRun: true })).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_ALREADY_UNDONE' })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('dry-runs a live merge into a preview', async () => {
    const { mock, ctx } = setup()
    mock.setTable('customer_merges', {
      data: { id: MERGE_ID, survivor_id: SURVIVOR, merged_id: DUPLICATE, undone_at: null, created_at: new Date().toISOString() },
    })

    expect(await undoCustomerMerge(ctx, MERGE_ID, { dryRun: true })).toEqual({
      ok: true, dryRun: true, preview: { merge_id: MERGE_ID, survivor_customer_id: SURVIVOR, restored_customer_id: DUPLICATE },
    })
  })
})
