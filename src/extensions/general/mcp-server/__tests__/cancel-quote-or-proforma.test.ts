/**
 * gnubok_cancel_quote_or_proforma (accounted#20), generated from the
 * operation invoices.cancel: the tool stages a cancel_quote_or_proforma
 * pending operation after a dry run that writes nothing, refuses at staging
 * what could never commit, and the approval runs the same service the
 * dashboard route calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { tools, isDefaultCatalogTool, isStagingTool, STAGE_BRIDGE_TARGETS } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { eventBus } from '@/lib/events'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const TOOL = 'gnubok_cancel_quote_or_proforma'
const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'

const QUOTE = {
  id: QUOTE_ID,
  company_id: COMPANY_ID,
  invoice_number: 'OF-007',
  document_type: 'quote',
  status: 'sent',
  quote_status: 'open',
  invoice_date: '2026-10-01',
  total: 12500,
  currency: 'SEK',
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

function recordingClient(rows: Record<string, unknown>) {
  const db = createTableMockSupabase(Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, { data }])))
  return {
    db,
    client: db.supabase as never,
    writes: () => db.calls.filter((c) => WRITES.has(c.method)).map((c) => c.table),
  }
}

const tool = () => {
  const found = tools.find((t) => t.name === TOOL)
  if (!found) throw new Error(`tool ${TOOL} not registered`)
  return found
}

const cancelled = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  eventBus.on('invoice.cancelled', cancelled)
})

describe('gnubok_cancel_quote_or_proforma', () => {
  it('is a search-only staged write under invoices:write, on the stage bridge, within the description budget', () => {
    expect(isDefaultCatalogTool(tool())).toBe(false)
    expect(TOOL_SCOPE_MAP[TOOL]).toBe('invoices:write')
    expect(isStagingTool(tool())).toBe(true)
    expect(STAGE_BRIDGE_TARGETS.map((t) => t.name)).toContain(TOOL)
    expect(tool().description.length).toBeLessThanOrEqual(280)
    expect(tool().description).not.toMatch(/[\u2013\u2014]/)
  })

  it('stages after a dry run that writes only the pending operation', async () => {
    const { db, client, writes } = recordingClient({
      invoices: QUOTE,
      pending_operations: { id: 'pending-1', status: 'pending', operation_type: 'cancel_quote_or_proforma', created_at: '2026-10-15T09:00:00Z' },
    })

    const result = (await tool().execute({ invoice_id: QUOTE_ID }, COMPANY_ID, USER_ID, client)) as Record<string, unknown>

    expect(result.staged).toBe(true)
    expect(writes()).toEqual(['pending_operations'])
    const insert = db.payloads('pending_operations', 'insert')[0] as Record<string, unknown>
    expect(insert).toMatchObject({
      operation_type: 'cancel_quote_or_proforma',
      title: 'Makulera offert OF-007',
      params: { invoice_id: QUOTE_ID },
      risk_level: 'low',
    })
    expect(result.preview).toMatchObject({ invoice_number: 'OF-007', current_status: 'sent', status: 'cancelled' })
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('refuses a sales invoice at staging without staging anything', async () => {
    const { client, writes } = recordingClient({ invoices: { ...QUOTE, document_type: 'invoice', quote_status: null } })

    await expect(tool().execute({ invoice_id: QUOTE_ID }, COMPANY_ID, USER_ID, client)).rejects.toMatchObject({
      code: 'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA',
    })
    expect(writes()).toEqual([])
  })

  it('refuses an already cancelled document at staging: nothing is left to approve', async () => {
    const { client, writes } = recordingClient({ invoices: { ...QUOTE, status: 'cancelled' } })

    await expect(tool().execute({ invoice_id: QUOTE_ID }, COMPANY_ID, USER_ID, client)).rejects.toMatchObject({
      code: 'INVOICE_ALREADY_CANCELLED',
    })
    expect(writes()).toEqual([])
  })
})

function makePendingOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: 'op-1',
    user_id: USER_ID,
    company_id: COMPANY_ID,
    operation_type: 'cancel_quote_or_proforma',
    status: 'pending',
    title: 'Makulera offert OF-007',
    params: { invoice_id: QUOTE_ID },
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-10-15T09:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-15T09:00:00Z',
    ...overrides,
  } as PendingOperation
}

describe('approving a staged cancel_quote_or_proforma', () => {
  it('runs the shared service: the quote is cancelled with a compare-and-set and the event records the approver', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-1' } }, // CAS claim
      { data: QUOTE }, // read the quote
      { data: { ...QUOTE, status: 'cancelled' } }, // compare-and-set update
      { data: null }, // finalize the pending operation
    ])

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, makePendingOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ id: QUOTE_ID, status: 'cancelled', already_cancelled: false })
    const updates = findCalls('invoices', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({ status: 'cancelled' })
    expect(findCalls('invoices', 'eq')).toContainEqual(['status', 'sent'])
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(cancelled.mock.calls[0][0]).toMatchObject({ userId: USER_ID, companyId: COMPANY_ID })
  })

  it('lands a document converted in between as a refusal with the registry code', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-1' } }, // CAS claim
      { data: { ...QUOTE, document_type: 'invoice' } }, // no longer a quote
      { data: null }, // dispatcher reject update
    ])

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, makePendingOp())

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA')
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })
})
