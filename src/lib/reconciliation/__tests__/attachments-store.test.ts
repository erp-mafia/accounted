import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  getAttachmentRow,
  insertAttachmentRow,
  listAttachmentRows,
  listAttachmentRowsInRange,
  stampAttachmentRemoved,
  toPublicAttachment,
} from '../attachments-store'

const COMPANY = 'company-1'
const TABLE = 'account_reconciliation_attachments'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    account_key: 'manual:2350',
    through_date: '2026-12-31',
    file_name: 'engagemangsbesked.pdf',
    mime_type: 'application/pdf',
    size_bytes: '12345',
    storage_bucket: 'documents',
    storage_path: 'company-1/reconciliation/manual:2350/2026-12-31/a1.pdf',
    sha256: 'ab'.repeat(32),
    note: null,
    uploaded_by: 'u1',
    uploaded_at: '2027-01-10T08:00:00Z',
    removed_at: null,
    removed_by: null,
    removed_reason: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('attachments-store', () => {
  it('lists active files for one account and balansdag, coercing size to a number', async () => {
    const { supabase, enqueue, findCalls, findCall } = createQueuedMockSupabase()
    enqueue({ data: [row()] })
    const rows = await listAttachmentRows(supabase as never, COMPANY, 'manual:2350', '2026-12-31')
    expect(rows).toHaveLength(1)
    expect(rows[0].size_bytes).toBe(12345)
    const eqs = findCalls(TABLE, 'eq').map((a) => a[0])
    expect(eqs).toEqual(['company_id', 'account_key', 'through_date'])
    expect(findCall(TABLE, 'is')).toEqual(['removed_at', null])
  })

  it('includes removed rows only on request', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [row({ removed_at: '2027-01-11T08:00:00Z', removed_by: 'u1' })] })
    const rows = await listAttachmentRows(supabase as never, COMPANY, 'manual:2350', '2026-12-31', { includeRemoved: true })
    expect(rows[0].removed_at).toBe('2027-01-11T08:00:00Z')
    expect(findCall(TABLE, 'is')).toBeUndefined()
  })

  it('lists a date range for the pärm', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [row(), row({ id: 'a2', account_key: 'skattekonto' })] })
    const rows = await listAttachmentRowsInRange(supabase as never, COMPANY, '2026-01-01', '2026-12-31')
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2'])
    expect(findCall(TABLE, 'gte')).toEqual(['through_date', '2026-01-01'])
    expect(findCall(TABLE, 'lte')).toEqual(['through_date', '2026-12-31'])
  })

  it('strips bucket and path from the public shape', () => {
    const pub = toPublicAttachment({ ...row(), size_bytes: 12345 } as never)
    expect(pub).not.toHaveProperty('storage_path')
    expect(pub).not.toHaveProperty('storage_bucket')
    expect(pub.file_name).toBe('engagemangsbesked.pdf')
  })

  it('inserts with the company id and returns the row', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: row() })
    const r = await insertAttachmentRow(supabase as never, COMPANY, {
      account_key: 'manual:2350',
      through_date: '2026-12-31',
      file_name: 'engagemangsbesked.pdf',
      mime_type: 'application/pdf',
      size_bytes: 12345,
      storage_bucket: 'documents',
      storage_path: 'company-1/reconciliation/manual:2350/2026-12-31/a1.pdf',
      sha256: 'ab'.repeat(32),
      note: null,
      uploaded_by: 'u1',
    })
    expect(r.id).toBe('a1')
    expect(findCall(TABLE, 'insert')?.[0]).toMatchObject({ company_id: COMPANY, account_key: 'manual:2350', uploaded_by: 'u1' })
  })

  it('stamps removal only on an active row and returns null otherwise', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await stampAttachmentRemoved(supabase as never, COMPANY, 'a1', { removed_by: 'u1', reason: null })).toBeNull()
    expect(findCall(TABLE, 'update')?.[0]).toMatchObject({ removed_by: 'u1', removed_reason: null })
    expect(findCall(TABLE, 'is')).toEqual(['removed_at', null])
  })

  it('reads one row by id within the account scope', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row() })
    const r = await getAttachmentRow(supabase as never, COMPANY, 'manual:2350', 'a1')
    expect(r?.storage_path).toContain('reconciliation')
    enqueue({ data: null })
    expect(await getAttachmentRow(supabase as never, COMPANY, 'manual:2350', 'nope')).toBeNull()
  })
})
