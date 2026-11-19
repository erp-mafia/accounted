/**
 * archiveSupplier (crm#1796): the rule behind the v1 DELETE /suppliers/:id
 * and the MCP gnubok_archive_supplier. A supplier with an open supplier
 * invoice stays; otherwise archived_at is set and the row is kept.
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { OPEN_SUPPLIER_INVOICE_STATUSES, archiveSupplier } from '../archive-supplier'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STORED = { id: SUPPLIER_ID, name: 'Elnät AB', archived_at: null, default_dimensions: {} }

function ctxWith(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  return {
    mock,
    ctx: { supabase: mock.supabase as never, companyId: COMPANY_ID, userId: 'user-1', log: createLogger('test') },
  }
}

describe('archiveSupplier', () => {
  it('answers not found for an id that is no uuid, without a query', async () => {
    const { ctx, mock } = ctxWith({})
    const outcome = await archiveSupplier(ctx, 'not-a-uuid')
    expect(outcome).toEqual({ ok: false, code: 'SUPPLIER_NOT_FOUND' })
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses while an open supplier invoice names the supplier, on the dry run too', async () => {
    for (const dryRun of [true, false]) {
      const { ctx, mock } = ctxWith({ supplier_invoices: { data: null, count: 2 } })
      const outcome = await archiveSupplier(ctx, SUPPLIER_ID, { dryRun })
      expect(outcome).toEqual({ ok: false, code: 'SUPPLIER_HAS_INVOICES', details: { open_invoice_count: 2 } })
      expect(mock.findCall('suppliers', 'update')).toBeUndefined()
    }
  })

  it('counts only the open statuses of this company and supplier', async () => {
    const { ctx, mock } = ctxWith({ supplier_invoices: { data: null, count: 0 }, suppliers: { data: STORED } })
    await archiveSupplier(ctx, SUPPLIER_ID, { dryRun: true })
    const invoiceCalls = mock.calls.filter((call) => call.table === 'supplier_invoices')
    expect(invoiceCalls.find((call) => call.method === 'in')?.args).toEqual(['status', [...OPEN_SUPPLIER_INVOICE_STATUSES]])
    expect(invoiceCalls.filter((call) => call.method === 'eq').map((call) => call.args)).toEqual([
      ['company_id', COMPANY_ID],
      ['supplier_id', SUPPLIER_ID],
    ])
    expect(OPEN_SUPPLIER_INVOICE_STATUSES).toEqual(['registered', 'approved', 'partially_paid', 'overdue', 'disputed'])
  })

  it('previews the supplier as archived and writes nothing on a dry run', async () => {
    const { ctx, mock } = ctxWith({ supplier_invoices: { data: null, count: 0 }, suppliers: { data: STORED } })
    const outcome = await archiveSupplier(ctx, SUPPLIER_ID, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { id: SUPPLIER_ID, supplier_id: SUPPLIER_ID, name: 'Elnät AB' } })
    const preview = (outcome as { preview: Record<string, unknown> }).preview
    expect(typeof preview.archived_at).toBe('string')
    expect(mock.findCall('suppliers', 'update')).toBeUndefined()
  })

  it('answers not found for a supplier of another company', async () => {
    for (const dryRun of [true, false]) {
      const { ctx } = ctxWith({ supplier_invoices: { data: null, count: 0 }, suppliers: { data: null } })
      expect(await archiveSupplier(ctx, SUPPLIER_ID, { dryRun })).toEqual({ ok: false, code: 'SUPPLIER_NOT_FOUND' })
    }
  })

  it('sets archived_at and the legacy is_active flag, scoped to the company, and deletes nothing', async () => {
    const archived = { ...STORED, archived_at: '2026-11-12T00:00:00.000Z' }
    const { ctx, mock } = ctxWith({ supplier_invoices: { data: null, count: 0 }, suppliers: { data: archived } })
    const outcome = await archiveSupplier(ctx, SUPPLIER_ID)
    expect(outcome).toEqual({ ok: true, data: archived })
    const update = mock.findCall('suppliers', 'update')?.[0] as Record<string, unknown>
    expect(Object.keys(update).sort()).toEqual(['archived_at', 'is_active'])
    expect(update.is_active).toBe(false)
    expect(typeof update.archived_at).toBe('string')
    const supplierCalls = mock.calls.filter((call) => call.table === 'suppliers')
    expect(supplierCalls.filter((call) => call.method === 'eq').map((call) => call.args)).toEqual([
      ['company_id', COMPANY_ID],
      ['id', SUPPLIER_ID],
    ])
    expect(supplierCalls.some((call) => call.method === 'delete')).toBe(false)
  })

  it('hands a database error to the door', async () => {
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { ctx } = ctxWith({ supplier_invoices: { data: null, error: dbError } })
    expect(await archiveSupplier(ctx, SUPPLIER_ID)).toEqual({ ok: false, code: 'SUPPLIER_UPDATE_FAILED', error: dbError })
  })
})
